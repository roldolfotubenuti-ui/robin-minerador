using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
#if NETCOREAPP || NET5_0_OR_GREATER
using System.Text.Json;
using System.Text.Json.Serialization;
#else
using System.Web.Script.Serialization;
#endif
using Microsoft.Win32;

namespace RobinCompanion
{
    public sealed class JobItemRequest
    {
        public string shortcode { get; set; }
        public string permalink { get; set; }
        public string videoUrl { get; set; }
        public int index { get; set; }
        public int score { get; set; }
        public long views { get; set; }
        public long likes { get; set; }
        public long comments { get; set; }
        public long shares { get; set; }
        public long timestamp { get; set; }
        public string caption { get; set; }
    }

    public sealed class CreateJobRequest
    {
        public string platform { get; set; }
        public string profile { get; set; }
        public string archiveMode { get; set; }
        public int batchSize { get; set; }
        public bool includeCsv { get; set; }
        public string deviceId { get; set; }
        public string userId { get; set; }
        public string sessionToken { get; set; }
        public string authTicket { get; set; }
        public long ticketExpiresAt { get; set; }
        public List<JobItemRequest> items { get; set; }
    }

    public sealed class JobFailure
    {
        public string shortcode { get; set; }
        public string error { get; set; }
    }

    public sealed class JobState
    {
        public string id;
        public string status;
        public string platform;
        public string profile;
        public string stage;
        public int total;
        public int completed;
        public int failed;
        public int inProgress;
        public int percent;
        public string error;
        public string zipPath;
        public long zipSizeBytes;
        public string zipSizeFormatted;
        public int verifiedMp4Count;
        public bool zipVerified;
        public List<string> filenames;
        public List<string> completedShortcodes;
        public List<JobFailure> failures;

#if NETCOREAPP || NET5_0_OR_GREATER
        [JsonIgnore]
#else
        [ScriptIgnore]
#endif
        public CancellationTokenSource Cts;

#if NETCOREAPP || NET5_0_OR_GREATER
        [JsonIgnore]
#else
        [ScriptIgnore]
#endif
        public ConcurrentDictionary<int, Process> ActiveProcesses;

        public JobState()
        {
            id = Guid.NewGuid().ToString("N");
            status = "running";
            stage = "Iniciando job no Robin Companion...";
            percent = 2;
            error = "";
            zipPath = "";
            zipSizeBytes = 0;
            zipSizeFormatted = "";
            verifiedMp4Count = 0;
            zipVerified = false;
            filenames = new List<string>();
            completedShortcodes = new List<string>();
            failures = new List<JobFailure>();
            Cts = new CancellationTokenSource();
            ActiveProcesses = new ConcurrentDictionary<int, Process>();
        }
    }

    internal static class JsonHelper
    {
        public static string Serialize(object obj)
        {
#if NETCOREAPP || NET5_0_OR_GREATER
            var options = new JsonSerializerOptions
            {
                PropertyNamingPolicy = null,
                WriteIndented = false
            };
            return JsonSerializer.Serialize(obj, options);
#else
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            return serializer.Serialize(obj);
#endif
        }

        public static T Deserialize<T>(string json)
        {
#if NETCOREAPP || NET5_0_OR_GREATER
            var options = new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true
            };
            return JsonSerializer.Deserialize<T>(json, options);
#else
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            return serializer.Deserialize<T>(json);
#endif
        }
    }

    public static class ProcessExtensions
    {
        public static async Task<bool> WaitForExitSafeAsync(this Process process, CancellationToken cancellationToken)
        {
#if NETCOREAPP || NET5_0_OR_GREATER
            await process.WaitForExitAsync(cancellationToken);
            return true;
#else
            var tcs = new TaskCompletionSource<bool>();
            process.EnableRaisingEvents = true;
            EventHandler handler = null;
            handler = (s, e) =>
            {
                process.Exited -= handler;
                tcs.TrySetResult(true);
            };
            process.Exited += handler;

            if (process.HasExited)
            {
                process.Exited -= handler;
                return true;
            }

            using (cancellationToken.Register(() =>
            {
                tcs.TrySetCanceled();
            }))
            {
                return await tcs.Task;
            }
#endif
        }
    }

    public static class MachineDeviceManager
    {
        private static readonly object SyncLock = new object();
        private static string _cachedDeviceId;
        private static string _cachedPublicKeyXml;
        private static RSACryptoServiceProvider _rsa;
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("ROBIN_DEVICE_IDENTITY_ENTROPY_v1_dpapi");

        public static string DeviceId
        {
            get
            {
                EnsureInitialized();
                return _cachedDeviceId;
            }
        }

        public static string PublicKeyXml
        {
            get
            {
                EnsureInitialized();
                return _cachedPublicKeyXml;
            }
        }

        public static void EnsureInitialized()
        {
            if (_rsa != null) return;
            lock (SyncLock)
            {
                if (_rsa != null) return;

                string baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Robin", "DeviceIdentity");
                Directory.CreateDirectory(baseDir);

                string keyPath = Path.Combine(baseDir, "device.key.dpapi");
                string idPath = Path.Combine(baseDir, "device.id");
                string pubPath = Path.Combine(baseDir, "device.pub");

                if (File.Exists(keyPath) && File.Exists(idPath) && File.Exists(pubPath))
                {
                    try
                    {
                        byte[] encBytes = File.ReadAllBytes(keyPath);
                        byte[] rawBytes = ProtectedData.Unprotect(encBytes, Entropy, DataProtectionScope.LocalMachine);
                        var rsa = new RSACryptoServiceProvider(2048);
                        rsa.ImportCspBlob(rawBytes);

                        _rsa = rsa;
                        _cachedDeviceId = File.ReadAllText(idPath, Encoding.UTF8).Trim();
                        _cachedPublicKeyXml = File.ReadAllText(pubPath, Encoding.UTF8).Trim();
                        return;
                    }
                    catch
                    {
                        // Se estiver corrompido ou copiado de outro PC, gera uma nova chave atrelada a este PC
                    }
                }

                var newRsa = new RSACryptoServiceProvider(2048);
                byte[] cspBlob = newRsa.ExportCspBlob(true);
                byte[] protectedBytes = ProtectedData.Protect(cspBlob, Entropy, DataProtectionScope.LocalMachine);
                File.WriteAllBytes(keyPath, protectedBytes);

                byte[] pubBlob = newRsa.ExportCspBlob(false);
                using (var sha = SHA256.Create())
                {
                    byte[] hash = sha.ComputeHash(pubBlob);
                    StringBuilder sb = new StringBuilder("ROBIN-PC-");
                    for (int i = 0; i < hash.Length; i++)
                    {
                        sb.Append(hash[i].ToString("x2"));
                    }
                    _cachedDeviceId = sb.ToString();
                }

                _cachedPublicKeyXml = newRsa.ToXmlString(false);

                File.WriteAllText(idPath, _cachedDeviceId, Encoding.UTF8);
                File.WriteAllText(pubPath, _cachedPublicKeyXml, Encoding.UTF8);
                _rsa = newRsa;
            }
        }

        public static string SignPayload(string payload)
        {
            EnsureInitialized();
            byte[] data = Encoding.UTF8.GetBytes(payload ?? "");
            byte[] sig = _rsa.SignData(data, CryptoConfig.MapNameToOID("SHA256"));
            return Convert.ToBase64String(sig);
        }

        public static bool VerifySignature(string payload, string signatureBase64, string publicKeyXml = null)
        {
            try
            {
                byte[] data = Encoding.UTF8.GetBytes(payload ?? "");
                byte[] sig = Convert.FromBase64String(signatureBase64);
                if (string.IsNullOrEmpty(publicKeyXml))
                {
                    EnsureInitialized();
                    return _rsa.VerifyData(data, CryptoConfig.MapNameToOID("SHA256"), sig);
                }
                using (var rsaCheck = new RSACryptoServiceProvider())
                {
                    rsaCheck.FromXmlString(publicKeyXml);
                    return rsaCheck.VerifyData(data, CryptoConfig.MapNameToOID("SHA256"), sig);
                }
            }
            catch
            {
                return false;
            }
        }

        private const string BackendPublicKeyXml = "<RSAKeyValue><Modulus>v+DOr++gkTRiEDhvqqdcn/PHIOf0Nbw3sJzIXiKsF1VHYzSz/Rbg9T3DWo8VeRJaLeK/DgOFmewDqzUj+fKrTiNn+fLEVFvy0NVAWjX7kaFptl0kQm+4Ye4LWC/MuZK8MY3AtF/fHeK7LyMsmbeDzjdmpLZhSAM726kQzFNkmA0NPktzbW5O/LS8Fe9FFrKpReJbZOckGyAO5BOy9991BSDuuKtxLThZ2CuvxwxAQNKBLjgl4nZIyDq51b2UlwcDlMtFt7cWcskl1/HsBkIiF4QYcZPYQ9GpqYNZZl0dybbEZGC2D451Zb0YEKwDsUDhkl3Q4M4HbNz6wIA+HD1IQw==</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>";

        public static bool VerifyDownloadTicket(string userId, string deviceId, long expiresAt, int itemCount, string ticketBase64)
        {
            try
            {
                if (string.IsNullOrEmpty(userId) || string.IsNullOrEmpty(deviceId) || string.IsNullOrEmpty(ticketBase64))
                    return false;

                long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                if (expiresAt < now)
                    return false;

                string payload = userId + ":" + deviceId + ":" + expiresAt + ":" + itemCount;
                byte[] data = Encoding.UTF8.GetBytes(payload);
                byte[] signature = Convert.FromBase64String(ticketBase64);

                using (var rsa = new RSACryptoServiceProvider())
                {
                    rsa.FromXmlString(BackendPublicKeyXml);
                    return rsa.VerifyData(data, CryptoConfig.MapNameToOID("SHA256"), signature);
                }
            }
            catch
            {
                return false;
            }
        }
    }

    internal static class Program
    {
        private const string ListenPrefix = "http://127.0.0.1:17832/";
        private const int DefaultMaxConcurrency = 3;
        private static readonly SemaphoreSlim GlobalThrottle = new SemaphoreSlim(DefaultMaxConcurrency, 4);
        private static readonly ConcurrentDictionary<string, JobState> Jobs = new ConcurrentDictionary<string, JobState>();
        private static readonly HttpClient DirectHttpClient = CreateHttpClient();

        private static HttpClient CreateHttpClient()
        {
            var handler = new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 5
            };
            var client = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(60)
            };
            client.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
            return client;
        }

        [STAThread]
        public static void Main(string[] args)
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            if (args != null && args.Any(a => string.Equals(a, "--enable-autostart", StringComparison.OrdinalIgnoreCase)))
            {
                ConfigureWindowsAutoStart();
            }

            bool isNewInstance;
            using (var mutex = new Mutex(true, "Local\\JDarkCompanionSingletonMutex", out isNewInstance))
            {
                if (!isNewInstance)
                {
                    return;
                }

                var listener = new HttpListener();
                listener.Prefixes.Add(ListenPrefix);
                listener.Start();

                while (listener.IsListening)
                {
                    try
                    {
                        var ctx = listener.GetContext();
                        Task.Run(() => HandleHttpContext(ctx));
                    }
                    catch
                    {
                        if (!listener.IsListening) break;
                    }
                }
            }
        }

        private static void ConfigureWindowsAutoStart()
        {
            try
            {
                string exePath = Process.GetCurrentProcess().MainModule?.FileName;
                if (string.IsNullOrWhiteSpace(exePath)) return;
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key != null)
                    {
                        key.SetValue("RobinCompanion", "\"" + exePath + "\"");
                    }
                }
            }
            catch { }
        }

        private static string ResolveOutputDir()
        {
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string dir = Path.Combine(userProfile, "Downloads", "Robin");
            Directory.CreateDirectory(dir);
            return dir;
        }

        private static string FindResourceBinary(string exeName)
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            string c1 = Path.Combine(baseDir, "resources", exeName);
            if (File.Exists(c1)) return c1;
            string c2 = Path.Combine(baseDir, exeName);
            if (File.Exists(c2)) return c2;
            return exeName;
        }

        // ID Oficial da Extensão Robin Minerador (derivado da chave pública permanente no manifest.json)
        public const string OfficialExtensionId = "hgincoajmnejgbedgohffbjalbfddnin";

        // Conjunto de IDs autorizados (Extensão Oficial + Configuração de Desenvolvimento)
        private static readonly HashSet<string> AllowedExtensionIds = InitializeAllowedExtensionIds();

        // Portas locais de desenvolvimento removidas da configuração comercial
        // Permitida apenas a porta local do próprio serviço Companion
        private static readonly HashSet<int> AllowedLocalPorts = new HashSet<int> { 17832 };

        private static HashSet<string> InitializeAllowedExtensionIds()
        {
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { OfficialExtensionId };

            // Variável de ambiente opcional para testes em desenvolvimento
            string envDev = Environment.GetEnvironmentVariable("ROBIN_DEV_EXTENSION_ID");
            if (!string.IsNullOrEmpty(envDev))
            {
                ids.Add(envDev.Trim());
            }

            // Arquivo opcional local dev_extension_id.txt
            try
            {
                string devFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "dev_extension_id.txt");
                if (File.Exists(devFile))
                {
                    foreach (string line in File.ReadAllLines(devFile))
                    {
                        string trimmed = line.Trim();
                        if (trimmed.Length == 32) ids.Add(trimmed);
                    }
                }
            }
            catch { }

            return ids;
        }

        private static bool IsAuthorizedOrigin(string origin)
        {
            if (string.IsNullOrEmpty(origin)) return false;
            if (!Uri.TryCreate(origin.Trim(), UriKind.Absolute, out Uri uri)) return false;

            // CORREÇÃO 1: Validação por comparação EXATA com o ID da extensão oficial
            if (string.Equals(uri.Scheme, "chrome-extension", StringComparison.OrdinalIgnoreCase))
            {
                return AllowedExtensionIds.Contains(uri.Host);
            }

            // CORREÇÃO 2: Portas locais estritamente restritas
            if (string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase))
            {
                if (string.Equals(uri.Host, "127.0.0.1", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(uri.Host, "[::1]", StringComparison.OrdinalIgnoreCase))
                {
                    return AllowedLocalPorts.Contains(uri.Port);
                }
            }

            return false;
        }

        private static void ApplyCors(HttpListenerRequest req, HttpListenerResponse res)
        {
            string origin = req.Headers["Origin"];
            if (!string.IsNullOrEmpty(origin) && IsAuthorizedOrigin(origin))
            {
                res.Headers["Access-Control-Allow-Origin"] = origin;
                res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
                res.Headers["Access-Control-Allow-Headers"] = "Content-Type, Accept, X-Robin-Client";
            }
            res.Headers["Cache-Control"] = "no-store";
        }

        private static void SendJson(HttpListenerResponse res, int statusCode, object payload)
        {
            string json = JsonHelper.Serialize(payload);
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            res.StatusCode = statusCode;
            res.ContentType = "application/json; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.Close();
        }

        private static void HandleHttpContext(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            var res = ctx.Response;
            ApplyCors(req, res);

            string origin = req.Headers["Origin"];
            string path = (req.Url != null ? req.Url.AbsolutePath : "").TrimEnd('/');
            if (string.IsNullOrEmpty(path)) path = "/";

            // CORREÇÃO 1 & 2: Validação estrita de Origin se origin estiver presente
            if (!string.IsNullOrEmpty(origin))
            {
                if (!IsAuthorizedOrigin(origin))
                {
                    SendJson(res, 403, new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", "Origem não autorizada. Acesso restrito à extensão oficial Robin Minerador e ao localhost." }
                    });
                    return;
                }
            }
            else
            {
                // CORREÇÃO 3: Origin ausente - não tratar como prova de legitimidade
                // /health é permitida sem credenciais para monitoramento operacional básico
                if (path != "/health" && path != "/" && path != "/status")
                {
                    string clientHeader = req.Headers["X-Robin-Client"];
                    if (string.IsNullOrEmpty(clientHeader) || !string.Equals(clientHeader, "robin-extension-v2", StringComparison.OrdinalIgnoreCase))
                    {
                        SendJson(res, 401, new Dictionary<string, object>
                        {
                            { "ok", false },
                            { "error", "Requisição não autorizada. O cabeçalho X-Robin-Client é obrigatório para chamadas locais." }
                        });
                        return;
                    }
                }
            }

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.Close();
                return;
            }

            try
            {
                if (req.HttpMethod == "GET" && path == "/health")
                {
                    SendJson(res, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "service", "robin-companion" },
                        { "serviceAlt", "jdark-companion" },
                        { "version", "2.0.0" },
                        { "concurrency", DefaultMaxConcurrency },
                        { "ytDlp", File.Exists(FindResourceBinary("yt-dlp.exe")) },
                        { "ffmpeg", File.Exists(FindResourceBinary("ffmpeg.exe")) }
                    });
                    return;
                }

                if (req.HttpMethod == "GET" && path == "/device/identity")
                {
                    SendJson(res, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "deviceId", MachineDeviceManager.DeviceId },
                        { "publicKey", MachineDeviceManager.PublicKeyXml },
                        { "platform", "windows" },
                        { "version", "2.0.0" }
                    });
                    return;
                }

                if (req.HttpMethod == "POST" && path == "/device/sign")
                {
                    string body;
                    using (var reader = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        body = reader.ReadToEnd();
                    }
                    var dict = JsonHelper.Deserialize<Dictionary<string, string>>(body);
                    string payload = dict != null && dict.ContainsKey("payload") ? dict["payload"] : "";
                    if (string.IsNullOrEmpty(payload))
                    {
                        SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Payload para assinatura não fornecido." } });
                        return;
                    }

                    // Validação de formato seguro para assinatura: email:deviceId:nonce:timestamp ou email:timestamp:nonce
                    string[] parts = payload.Split(':');
                    if (parts.Length == 4)
                    {
                        string emailPart = parts[0];
                        string devPart = parts[1];
                        string noncePart = parts[2];
                        string tsPart = parts[3];

                        if (!emailPart.Contains("@") || !string.Equals(devPart, MachineDeviceManager.DeviceId, StringComparison.OrdinalIgnoreCase) || noncePart.Length < 8 || !long.TryParse(tsPart, out long ts4))
                        {
                            SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Desafio de dispositivo inválido ou vinculado a outro computador." } });
                            return;
                        }
                        long now4 = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        if (Math.Abs(now4 - ts4) > 300000)
                        {
                            SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Desafio expirado para prova de login." } });
                            return;
                        }
                    }
                    else if (parts.Length == 3)
                    {
                        string emailPart = parts[0];
                        string tsPart = parts[1];
                        string noncePart = parts[2];

                        if (!emailPart.Contains("@") || !long.TryParse(tsPart, out long ts3) || noncePart.Length < 4)
                        {
                            SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Formato de payload inválido para prova de login." } });
                            return;
                        }
                        long now3 = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        if (Math.Abs(now3 - ts3) > 300000)
                        {
                            SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Timestamp expirado para prova de login." } });
                            return;
                        }
                    }
                    else
                    {
                        SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Formato de payload inválido para assinatura de dispositivo." } });
                        return;
                    }

                    string signature = MachineDeviceManager.SignPayload(payload);
                    SendJson(res, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "deviceId", MachineDeviceManager.DeviceId },
                        { "publicKey", MachineDeviceManager.PublicKeyXml },
                        { "signature", signature },
                        { "payload", payload },
                        { "timestamp", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }
                    });
                    return;
                }

                if (req.HttpMethod == "POST" && path == "/device/verify")
                {
                    string body;
                    using (var reader = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        body = reader.ReadToEnd();
                    }
                    var dict = JsonHelper.Deserialize<Dictionary<string, string>>(body);
                    string payload = dict != null && dict.ContainsKey("payload") ? dict["payload"] : "";
                    string sig = dict != null && dict.ContainsKey("signature") ? dict["signature"] : "";
                    string pub = dict != null && dict.ContainsKey("publicKey") ? dict["publicKey"] : null;
                    bool valid = MachineDeviceManager.VerifySignature(payload, sig, pub);
                    SendJson(res, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "valid", valid }
                    });
                    return;
                }

                if (req.HttpMethod == "GET" && (path == "/" || path == "/status"))
                {
                    string html = "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><title>Robin Companion 2.0</title>" +
                        "<style>body{background:#090412;color:#f5eeff;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:95vh;margin:0}" +
                        ".card{background:#140a26;border:1px solid #9333ea;border-radius:18px;padding:28px;max-width:560px;box-shadow:0 20px 60px rgba(0,0,0,.7)}" +
                        "h1{margin:0 0 8px;color:#c084fc}p{color:#cbb8e2;line-height:1.5}.ok{color:#4ade80;font-weight:700}.badge{background:#2e1065;padding:4px 8px;border-radius:6px;border:1px solid #a855f7;font-size:12px;color:#f3e8ff}</style></head>" +
                        "<body><div class='card'><h1>Robin Companion 2.0</h1>" +
                        "<p class='ok'>● Servidor local ativo em 127.0.0.1:17832 <span class='badge'>Downloads Paralelos: ON (3x)</span></p>" +
                        "<p>Pasta de saída: <code>" + ResolveOutputDir() + "</code></p>" +
                        "<p>Motor de alta velocidade: yt-dlp + FFmpeg otimizados com remux MP4 nativo e download direto CDN.</p></div></body></html>";
                    byte[] buf = Encoding.UTF8.GetBytes(html);
                    res.StatusCode = 200;
                    res.ContentType = "text/html; charset=utf-8";
                    res.ContentLength64 = buf.Length;
                    res.OutputStream.Write(buf, 0, buf.Length);
                    res.Close();
                    return;
                }

                if (req.HttpMethod == "POST" && path == "/jobs")
                {
                    string body;
                    using (var reader = new StreamReader(req.InputStream, Encoding.UTF8))
                    {
                        body = reader.ReadToEnd();
                    }

                    var createReq = JsonHelper.Deserialize<CreateJobRequest>(body);

                    // 1. Validação de identidade do computador físico
                    if (createReq == null || string.IsNullOrEmpty(createReq.deviceId) || !string.Equals(createReq.deviceId, MachineDeviceManager.DeviceId, StringComparison.OrdinalIgnoreCase))
                    {
                        SendJson(res, 403, new Dictionary<string, object>
                        {
                            { "ok", false },
                            { "error", "Dispositivo não autorizado neste computador. Operação bloqueada pelo Robin Companion." }
                        });
                        return;
                    }

                    // 2. Validação da autorização criptográfica do backend (Ticket HMAC-SHA256)
                    int itemCount = createReq.items != null ? createReq.items.Count : 0;
                    if (!MachineDeviceManager.VerifyDownloadTicket(createReq.userId, createReq.deviceId, createReq.ticketExpiresAt, itemCount, createReq.authTicket))
                    {
                        SendJson(res, 403, new Dictionary<string, object>
                        {
                            { "ok", false },
                            { "error", "Autorização de download ausente, inválida ou expirada. Certifique-se de que sua assinatura do Robin Minerador está ativa." }
                        });
                        return;
                    }

                    if (itemCount == 0)
                    {
                        SendJson(res, 400, new Dictionary<string, object> { { "ok", false }, { "error", "Lista de vídeos vazia." } });
                        return;
                    }

                    var job = new JobState
                    {
                        platform = createReq.platform ?? "instagram",
                        profile = createReq.profile ?? "perfil",
                        total = createReq.items.Count
                    };
                    Jobs[job.id] = job;
                    Task.Run(() => ExecuteDownloadJobAsync(job, createReq));

                    SendJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "job", job } });
                    return;
                }

                if (path.StartsWith("/jobs/", StringComparison.OrdinalIgnoreCase))
                {
                    string[] parts = path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
                    string jobId = parts.Length >= 2 ? parts[1] : "";
                    JobState job;
                    if (!Jobs.TryGetValue(jobId, out job))
                    {
                        SendJson(res, 404, new Dictionary<string, object> { { "ok", false }, { "error", "Job não encontrado." } });
                        return;
                    }

                    if (req.HttpMethod == "POST" && parts.Length >= 3 && parts[2] == "cancel")
                    {
                        job.Cts.Cancel();
                        KillAllActiveProcesses(job);
                        job.status = "error";
                        job.stage = "Cancelado pelo usuário";
                        job.error = "Download cancelado pelo usuário.";
                        SendJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "job", job } });
                        return;
                    }

                    SendJson(res, 200, new Dictionary<string, object> { { "ok", true }, { "job", job } });
                    return;
                }

                SendJson(res, 404, new Dictionary<string, object> { { "ok", false }, { "error", "Rota não encontrada." } });
            }
            catch (Exception ex)
            {
                SendJson(res, 500, new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
            }
        }

        private static void KillAllActiveProcesses(JobState job)
        {
            try
            {
                foreach (var kvp in job.ActiveProcesses)
                {
                    KillProcessTree(kvp.Value);
                }
                job.ActiveProcesses.Clear();
            }
            catch { }
        }

        private static void KillProcessTree(Process proc)
        {
            if (proc == null) return;
            try
            {
                if (proc.HasExited) return;
#if NETCOREAPP || NET5_0_OR_GREATER
                proc.Kill(entireProcessTree: true);
#else
                try
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = "taskkill",
                        Arguments = string.Format("/T /F /PID {0}", proc.Id),
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    using (var killer = Process.Start(psi))
                    {
                        killer?.WaitForExit(2000);
                    }
                }
                catch
                {
                    try { proc.Kill(); } catch { }
                }
#endif
            }
            catch { }
        }

        private static string SanitizePart(string input, string fallback)
        {
            var chars = (input ?? "").Where(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '.').ToArray();
            string s = new string(chars).Trim('_');
            return string.IsNullOrEmpty(s) ? fallback : s;
        }

        private static bool IsTrustedCdnDomain(string url, string platform)
        {
            if (string.IsNullOrWhiteSpace(url)) return false;
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri)) return false;
            string host = uri.Host.ToLowerInvariant();

            if (platform == "instagram")
            {
                return host == "cdninstagram.com" || host.EndsWith(".cdninstagram.com")
                    || host == "fbcdn.net" || host.EndsWith(".fbcdn.net")
                    || host == "instagram.com" || host.EndsWith(".instagram.com");
            }
            if (platform == "tiktok")
            {
                return host == "tiktokcdn.com" || host.EndsWith(".tiktokcdn.com")
                    || host == "tiktokv.com" || host.EndsWith(".tiktokv.com")
                    || host == "byteoversea.com" || host.EndsWith(".byteoversea.com")
                    || host == "ibytedtos.com" || host.EndsWith(".ibytedtos.com")
                    || host == "tiktok.com" || host.EndsWith(".tiktok.com");
            }
            if (platform == "youtube")
            {
                return host == "googlevideo.com" || host.EndsWith(".googlevideo.com")
                    || host == "ytimg.com" || host.EndsWith(".ytimg.com")
                    || host == "youtube.com" || host.EndsWith(".youtube.com")
                    || host == "googleapis.com" || host.EndsWith(".googleapis.com");
            }
            return false;
        }

        private static string FormatFileSize(long bytes)
        {
            if (bytes <= 0) return "0 B";
            string[] suffixes = { "B", "KB", "MB", "GB", "TB" };
            int counter = 0;
            decimal number = bytes;
            while (Math.Round(number / 1024m) >= 1m && counter < suffixes.Length - 1)
            {
                number /= 1024m;
                counter++;
            }
            return string.Format("{0:N1} {1}", number, suffixes[counter]);
        }

        private static async Task ExecuteDownloadJobAsync(JobState job, CreateJobRequest req)
        {
            string outRoot = ResolveOutputDir();
            string tempWorkDir = Path.Combine(Path.GetTempPath(), "robin_job_" + job.id);
            Directory.CreateDirectory(tempWorkDir);

            try
            {
                int batchSize = req.archiveMode == "single"
                    ? req.items.Count
                    : Math.Max(1, Math.Min(500, req.batchSize > 0 ? req.batchSize : 50));
                int totalParts = Math.Max(1, (int)Math.Ceiling(req.items.Count / (double)batchSize));
                string safeProfile = SanitizePart(req.profile, "perfil");
                string safePlatform = SanitizePart(req.platform, "social");

                int totalProcessedGlobal = 0;

                for (int partIdx = 0; partIdx < totalParts; partIdx++)
                {
                    job.Cts.Token.ThrowIfCancellationRequested();
                    var chunk = req.items.Skip(partIdx * batchSize).Take(batchSize).ToList();
                    string partFolder = Path.Combine(tempWorkDir, "part_" + (partIdx + 1));
                    string videosFolder = Path.Combine(partFolder, "videos");
                    Directory.CreateDirectory(videosFolder);

                    var partSucceeded = new JobItemRequest[chunk.Count];

                    // Execução paralela controlada via GlobalThrottle (limite de concorrência = 3)
                    var downloadTasks = chunk.Select(async (item, i) =>
                    {
                        job.Cts.Token.ThrowIfCancellationRequested();
                        int globalIndex = partIdx * batchSize + i + 1;
                        string fileName = string.Format("{0}_{1:D3}_{2}.mp4", safeProfile, globalIndex, SanitizePart(item.shortcode, "video"));
                        string targetFile = Path.Combine(videosFolder, fileName);

                        await GlobalThrottle.WaitAsync(job.Cts.Token);
                        Interlocked.Increment(ref job.inProgress);
                        try
                        {
                            job.Cts.Token.ThrowIfCancellationRequested();
                            await DownloadSingleVideoAsync(item, targetFile, req.platform, job, job.Cts.Token);

                            // Validação estrita do arquivo baixado (existência e tamanho > 1KB)
                            if (!File.Exists(targetFile) || new FileInfo(targetFile).Length < 1024)
                            {
                                throw new InvalidOperationException("Arquivo gerado está corrompido ou vazio.");
                            }

                            partSucceeded[i] = item;
                            Interlocked.Increment(ref job.completed);
                            // IMPORTANTE: NÃO registrar em completedShortcodes aqui!
                            // Apenas após a confirmação integral da criação e gravação do ZIP no disco.
                        }
                        catch (Exception ex)
                        {
                            if (File.Exists(targetFile))
                            {
                                try { File.Delete(targetFile); } catch { }
                            }
                            Interlocked.Increment(ref job.failed);
                            lock (job.failures)
                            {
                                job.failures.Add(new JobFailure { shortcode = item.shortcode, error = ex.Message });
                            }
                        }
                        finally
                        {
                            Interlocked.Decrement(ref job.inProgress);
                            GlobalThrottle.Release();

                            int processed = Interlocked.Increment(ref totalProcessedGlobal);
                            job.stage = string.Format("Baixando vídeos · {0}/{1} concluídos ({2} ativos)", job.completed, job.total, job.inProgress);
                            job.percent = Math.Max(4, Math.Min(88, (int)Math.Round((processed / (double)job.total) * 85)));
                        }
                    }).ToArray();

                    await Task.WhenAll(downloadTasks);

                    var successfulItems = partSucceeded.Where(it => it != null).ToList();
                    if (successfulItems.Count == 0) continue;

                    string partSuffix = totalParts > 1 ? string.Format("_lote_{0:D2}_de_{1:D2}", partIdx + 1, totalParts) : "";
                    if (req.includeCsv)
                    {
                        string csvPath = Path.Combine(partFolder, string.Format("metricas_{0}{1}.csv", safeProfile, partSuffix));
                        File.WriteAllText(csvPath, BuildCsvContent(req.platform, req.profile, successfulItems), new UTF8Encoding(true));
                    }

                    if (job.failures.Count > 0)
                    {
                        string failPath = Path.Combine(partFolder, "falhas.txt");
                        string failLines;
                        lock (job.failures)
                        {
                            failLines = string.Join(Environment.NewLine, job.failures.Select(f => f.shortcode + ": " + f.error));
                        }
                        File.WriteAllText(failPath, failLines, Encoding.UTF8);
                    }

                    job.stage = string.Format("Compactando e verificando ZIP {0}/{1}...", partIdx + 1, totalParts);
                    job.percent = 92;

                    string dateStr = DateTime.Now.ToString("yyyy-MM-dd");
                    string zipName = string.Format("Robin_{0}_{1}_{2}{3}.zip", safePlatform, safeProfile, dateStr, partSuffix);

                    // 1. Criar o ZIP em diretório temporário
                    string tempZipPath = Path.Combine(tempWorkDir, zipName + ".tmp");
                    if (File.Exists(tempZipPath)) File.Delete(tempZipPath);
                    ZipFile.CreateFromDirectory(partFolder, tempZipPath, CompressionLevel.Fastest, false);

                    // 2. Confirmar que o ZIP temporário existe
                    if (!File.Exists(tempZipPath))
                    {
                        throw new InvalidOperationException("Falha ao gerar o arquivo ZIP temporário.");
                    }

                    // 3. Verificar que o tamanho é maior que zero
                    var tempZipFi = new FileInfo(tempZipPath);
                    if (tempZipFi.Length <= 0)
                    {
                        throw new InvalidOperationException("O arquivo ZIP gerado está vazio (0 bytes).");
                    }

                    // 4. Validar a estrutura e as entradas internas do ZIP
                    int mp4InZipCount = 0;
                    bool csvInZipFound = false;
                    using (var archive = ZipFile.OpenRead(tempZipPath))
                    {
                        foreach (var entry in archive.Entries)
                        {
                            if (entry.FullName.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
                            {
                                mp4InZipCount++;
                            }
                            else if (entry.FullName.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                            {
                                csvInZipFound = true;
                            }
                        }
                    }

                    if (mp4InZipCount != successfulItems.Count)
                    {
                        throw new InvalidOperationException(string.Format("Inconsistência na estrutura do ZIP: {0} MP4s encontrados no arquivo (esperado: {1}).", mp4InZipCount, successfulItems.Count));
                    }
                    if (req.includeCsv && !csvInZipFound)
                    {
                        throw new InvalidOperationException("Inconsistência na estrutura do ZIP: o arquivo CSV de métricas não foi incluído.");
                    }

                    // 5. Mover para o diretório final Downloads/Robin
                    string zipFullPath = Path.Combine(outRoot, zipName);
                    if (File.Exists(zipFullPath)) File.Delete(zipFullPath);
                    File.Move(tempZipPath, zipFullPath);

                    // 6. Confirmar que o arquivo final foi salvo em Downloads/Robin e tamanho > 0
                    if (!File.Exists(zipFullPath))
                    {
                        throw new InvalidOperationException("Falha ao salvar o arquivo ZIP na pasta de Downloads: " + zipFullPath);
                    }

                    var finalZipFi = new FileInfo(zipFullPath);
                    if (finalZipFi.Length <= 0)
                    {
                        throw new InvalidOperationException("O arquivo ZIP gravado em disco possui 0 bytes.");
                    }

                    // 7. Atualizar metadados verificados do ZIP
                    job.zipPath = zipFullPath;
                    job.zipSizeBytes = finalZipFi.Length;
                    job.zipSizeFormatted = FormatFileSize(finalZipFi.Length);
                    job.verifiedMp4Count = mp4InZipCount;
                    job.zipVerified = true;
                    job.filenames.Add(zipName);

                    // 8. SOMENTE AGORA registrar os shortcodes como concluídos
                    lock (job.completedShortcodes)
                    {
                        foreach (var item in successfulItems)
                        {
                            if (!job.completedShortcodes.Contains(item.shortcode))
                            {
                                job.completedShortcodes.Add(item.shortcode);
                            }
                        }
                    }
                }

                if (job.completed == 0 || !job.zipVerified || job.completedShortcodes.Count == 0)
                {
                    job.status = "error";
                    job.stage = "Falha no download";
                    job.error = job.failures.Count > 0 ? job.failures[0].error : "Nenhum arquivo ZIP foi gerado com sucesso.";
                    lock (job.completedShortcodes)
                    {
                        job.completedShortcodes.Clear();
                    }
                }
                else
                {
                    job.status = "complete";
                    job.stage = string.Format("Concluído — salvo em {0} ({1})", job.zipPath, job.zipSizeFormatted);
                    job.percent = 100;
                }
            }
            catch (OperationCanceledException)
            {
                job.status = "error";
                job.stage = "Cancelado";
                job.error = "Download cancelado pelo usuário.";
                lock (job.completedShortcodes)
                {
                    job.completedShortcodes.Clear();
                }
            }
            catch (Exception ex)
            {
                job.status = "error";
                job.stage = "Erro durante processamento";
                job.error = ex.Message;
                lock (job.completedShortcodes)
                {
                    job.completedShortcodes.Clear();
                }
            }
            finally
            {
                KillAllActiveProcesses(job);
                try { Directory.Delete(tempWorkDir, true); } catch { }
            }
        }

        private static async Task DownloadSingleVideoAsync(JobItemRequest item, string targetFile, string platform, JobState job, CancellationToken ct)
        {
            // 1. PRIORIZAÇÃO DE CDN DIRETA:
            // Para Instagram e TikTok, quando a URL direta já foi enriquecida e é válida, baixa em 1-2 segundos direto da CDN
            if (!string.IsNullOrWhiteSpace(item.videoUrl) && (IsTrustedCdnDomain(item.videoUrl, platform) || item.videoUrl.Contains(".mp4") || item.videoUrl.Contains("cdninstagram") || item.videoUrl.Contains("fbcdn")))
            {
                try
                {
                    string referer = platform == "tiktok" ? (item.permalink ?? "https://www.tiktok.com/") : null;
                    await DownloadDirectCdnAsync(item.videoUrl, targetFile, ct, referer);
                    if (File.Exists(targetFile) && new FileInfo(targetFile).Length > 10000)
                    {
                        return;
                    }
                }
                catch
                {
                    if (File.Exists(targetFile)) { try { File.Delete(targetFile); } catch { } }
                    // Fallback automático para yt-dlp se a URL tiver expirado
                }
            }

            // 2. YOUTUBE SHORTS E FALLBACK DE OUTRAS PLATAFORMAS:
            // Executa yt-dlp com FFmpeg remux MP4 nativo na melhor qualidade disponível (bv*+ba/b)
            string ytDlpPath = FindResourceBinary("yt-dlp.exe");
            string ffmpegPath = FindResourceBinary("ffmpeg.exe");
            string resourceDir = (Path.GetDirectoryName(ffmpegPath) ?? AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');

            if (File.Exists(ytDlpPath) && !string.IsNullOrWhiteSpace(item.permalink))
            {
                try
                {
                    await RunYtDlpAsync(ytDlpPath, resourceDir, item.permalink, targetFile, job, ct);
                    if (File.Exists(targetFile) && new FileInfo(targetFile).Length > 10000)
                    {
                        return;
                    }
                }
                catch (Exception ytEx)
                {
                    // Fallback secundário se ainda houver videoUrl
                    if (!string.IsNullOrWhiteSpace(item.videoUrl))
                    {
                        try
                        {
                            await DownloadDirectCdnAsync(item.videoUrl, targetFile, ct);
                            if (File.Exists(targetFile) && new FileInfo(targetFile).Length > 10000)
                            {
                                return;
                            }
                        }
                        catch { }
                    }
                    throw ytEx;
                }
            }

            // 3. Último recurso se não tiver permalink mas tiver videoUrl
            if (!string.IsNullOrWhiteSpace(item.videoUrl))
            {
                await DownloadDirectCdnAsync(item.videoUrl, targetFile, ct);
                if (File.Exists(targetFile) && new FileInfo(targetFile).Length > 10000)
                {
                    return;
                }
            }

            throw new InvalidOperationException("Não foi possível obter o vídeo em alta qualidade pela plataforma.");
        }

        private static async Task DownloadDirectCdnAsync(string url, string targetFile, CancellationToken ct, string referer = null)
        {
            using (var request = new HttpRequestMessage(HttpMethod.Get, url))
            {
                if (!string.IsNullOrWhiteSpace(referer))
                {
                    request.Headers.Referrer = new Uri(referer);
                }

                using (var response = await DirectHttpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false))
                {
                    response.EnsureSuccessStatusCode();

                    using (var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var fs = new FileStream(targetFile, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
                    {
                        byte[] buffer = new byte[65536];
                        int bytesRead;
                        while ((bytesRead = await stream.ReadAsync(buffer, 0, buffer.Length, ct).ConfigureAwait(false)) > 0)
                        {
                            await fs.WriteAsync(buffer, 0, bytesRead, ct).ConfigureAwait(false);
                        }
                    }
                }
            }
        }

        private static async Task RunYtDlpAsync(string ytDlpPath, string resourceDir, string permalink, string targetFile, JobState job, CancellationToken ct)
        {
            // Timeout individual de 120s por vídeo para não travar a fila
            using (var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(120)))
            using (var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(ct, timeoutCts.Token))
            {
                // Configuração de qualidade máxima:
                // bv*+ba/b com remux/merge para MP4 via FFmpeg, preservando áudio original e resolução total
                string args = string.Format(
                    "--no-playlist --no-warnings --ffmpeg-location \"{0}\" -f \"bv*+ba/b\" --merge-output-format mp4 --remux-video mp4 --socket-timeout 30 -o \"{1}\" \"{2}\"",
                    resourceDir, targetFile, permalink
                );

                var psi = new ProcessStartInfo
                {
                    FileName = ytDlpPath,
                    Arguments = args,
                    WorkingDirectory = resourceDir,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true
                };

                string currentPath = Environment.GetEnvironmentVariable("PATH") ?? "";
                psi.EnvironmentVariables["PATH"] = resourceDir + ";" + currentPath;

                using (var proc = new Process { StartInfo = psi })
                {
                    var errBuilder = new StringBuilder();
                    proc.ErrorDataReceived += (s, e) =>
                    {
                        if (!string.IsNullOrWhiteSpace(e.Data))
                        {
                            lock (errBuilder)
                            {
                                if (errBuilder.Length < 1000) errBuilder.AppendLine(e.Data);
                            }
                        }
                    };

                    if (!proc.Start())
                    {
                        throw new InvalidOperationException("Falha ao inicializar o processo do yt-dlp.");
                    }

                    job.ActiveProcesses[proc.Id] = proc;
                    try
                    {
                        proc.BeginErrorReadLine();
                        proc.BeginOutputReadLine();

                        await proc.WaitForExitSafeAsync(linkedCts.Token);

                        if (proc.ExitCode != 0)
                        {
                            string errText = errBuilder.ToString().Trim();
                            throw new InvalidOperationException(!string.IsNullOrEmpty(errText)
                                ? "yt-dlp: " + errText
                                : "Falha na extração do vídeo pelo yt-dlp (código " + proc.ExitCode + ").");
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        KillProcessTree(proc);
                        if (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
                        {
                            throw new TimeoutException("Tempo limite (120s) excedido ao baixar vídeo via yt-dlp.");
                        }
                        throw;
                    }
                    finally
                    {
                        Process removed;
                        job.ActiveProcesses.TryRemove(proc.Id, out removed);
                    }
                }
            }
        }

        private static string BuildCsvContent(string platform, string profile, List<JobItemRequest> items)
        {
            Func<object, string> esc = v => "\"" + Convert.ToString(v ?? "").Replace("\"", "\"\"") + "\"";
            var sb = new StringBuilder();
            sb.AppendLine("plataforma,perfil,codigo,url,score_viral,visualizacoes,curtidas,comentarios,compartilhamentos,publicado_em,legenda,processado_em");
            string nowIso = DateTime.UtcNow.ToString("O");
            foreach (var it in items)
            {
                string pubIso = "";
                if (it.timestamp > 0)
                {
                    long secs = it.timestamp > 1000000000000L ? it.timestamp / 1000 : it.timestamp;
                    pubIso = DateTimeOffset.FromUnixTimeSeconds(secs).UtcDateTime.ToString("O");
                }
                string cleanCaption = (it.caption ?? "").Replace("\r", " ").Replace("\n", " ");
                string row = string.Join(",", new[]
                {
                    esc(platform), esc(profile), esc(it.shortcode), esc(it.permalink),
                    esc(it.score), esc(it.views), esc(it.likes), esc(it.comments),
                    esc(it.shares), esc(pubIso), esc(cleanCaption), esc(nowIso)
                });
                sb.AppendLine(row);
            }
            return sb.ToString();
        }
    }
}
