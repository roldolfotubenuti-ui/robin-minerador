using System;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace JDarkCompanion
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
        public List<JobItemRequest> items { get; set; }
    }

    public sealed class JobFailure
    {
        public string shortcode { get; set; }
        public string error { get; set; }
    }

    public sealed class JobState
    {
        public string id { get; set; }
        public string status { get; set; }
        public string platform { get; set; }
        public string profile { get; set; }
        public string stage { get; set; }
        public int total { get; set; }
        public int completed { get; set; }
        public int failed { get; set; }
        public int percent { get; set; }
        public string error { get; set; }
        public List<string> filenames { get; set; }
        public List<string> completedShortcodes { get; set; }
        public List<JobFailure> failures { get; set; }

        [ScriptIgnore]
        public CancellationTokenSource Cts { get; set; }

        public JobState()
        {
            id = Guid.NewGuid().ToString("N");
            status = "running";
            stage = "Iniciando job no J-Dark Companion...";
            percent = 2;
            error = "";
            filenames = new List<string>();
            completedShortcodes = new List<string>();
            failures = new List<JobFailure>();
            Cts = new CancellationTokenSource();
        }
    }

    internal static class Program
    {
        private const string ListenPrefix = "http://127.0.0.1:17832/";
        private static readonly ConcurrentDictionary<string, JobState> Jobs = new ConcurrentDictionary<string, JobState>();

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
                string exePath = Process.GetCurrentProcess().MainModule.FileName;
                if (string.IsNullOrWhiteSpace(exePath)) return;
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
                {
                    if (key != null)
                    {
                        key.SetValue("JDarkCompanion", "\"" + exePath + "\"");
                    }
                }
            }
            catch { }
        }

        private static string ResolveOutputDir()
        {
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string dir = Path.Combine(userProfile, "Downloads", "J-Dark");
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

        private static void ApplyCors(HttpListenerRequest req, HttpListenerResponse res)
        {
            string origin = req.Headers["Origin"] ?? "*";
            res.Headers["Access-Control-Allow-Origin"] = origin;
            res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
            res.Headers["Access-Control-Allow-Headers"] = "Content-Type, Accept";
            res.Headers["Cache-Control"] = "no-store";
        }

        private static void SendJson(HttpListenerResponse res, int statusCode, object payload)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
            string json = serializer.Serialize(payload);
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

            if (req.HttpMethod == "OPTIONS")
            {
                res.StatusCode = 204;
                res.Close();
                return;
            }

            string path = (req.Url != null ? req.Url.AbsolutePath : "").TrimEnd('/');
            if (string.IsNullOrEmpty(path)) path = "/";

            try
            {
                if (req.HttpMethod == "GET" && path == "/health")
                {
                    SendJson(res, 200, new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "service", "jdark-companion" },
                        { "version", "1.0.0" },
                        { "outputDir", ResolveOutputDir() },
                        { "ytDlp", File.Exists(FindResourceBinary("yt-dlp.exe")) },
                        { "ffmpeg", File.Exists(FindResourceBinary("ffmpeg.exe")) }
                    });
                    return;
                }

                if (req.HttpMethod == "GET" && (path == "/" || path == "/status"))
                {
                    string html = "<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'><title>J-Dark Companion 1.0</title>" +
                        "<style>body{background:#090412;color:#f5eeff;font-family:Segoe UI,sans-serif;display:grid;place-items:center;height:95vh;margin:0}" +
                        ".card{background:#140a26;border:1px solid #9333ea;border-radius:18px;padding:28px;max-width:540px;box-shadow:0 20px 60px rgba(0,0,0,.7)}" +
                        "h1{margin:0 0 8px;color:#c084fc}p{color:#cbb8e2;line-height:1.5}.ok{color:#4ade80;font-weight:700}</style></head>" +
                        "<body><div class='card'><h1>J-Dark Companion 1.0</h1>" +
                        "<p class='ok'>● Servidor local ativo em 127.0.0.1:17832</p>" +
                        "<p>Pasta de saída: <code>" + ResolveOutputDir() + "</code></p>" +
                        "<p>Use a extensão J-Dark no Chrome ou Edge para minerar perfis e baixar lotes em ZIP + CSV.</p></div></body></html>";
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

                    var serializer = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
                    var createReq = serializer.Deserialize<CreateJobRequest>(body);
                    if (createReq == null || createReq.items == null || createReq.items.Count == 0)
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
                    Task.Run(() => ExecuteDownloadJob(job, createReq));

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
                        job.status = "error";
                        job.stage = "Cancelado";
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

        private static string SanitizePart(string input, string fallback)
        {
            var chars = (input ?? "").Where(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '.').ToArray();
            string s = new string(chars).Trim('_');
            return string.IsNullOrEmpty(s) ? fallback : s;
        }

        private static void ExecuteDownloadJob(JobState job, CreateJobRequest req)
        {
            string outRoot = ResolveOutputDir();
            string tempWorkDir = Path.Combine(Path.GetTempPath(), "jdark_job_" + job.id);
            Directory.CreateDirectory(tempWorkDir);

            try
            {
                int batchSize = req.archiveMode == "single"
                    ? req.items.Count
                    : Math.Max(1, Math.Min(500, req.batchSize > 0 ? req.batchSize : 50));
                int totalParts = Math.Max(1, (int)Math.Ceiling(req.items.Count / (double)batchSize));
                string safeProfile = SanitizePart(req.profile, "perfil");
                string safePlatform = SanitizePart(req.platform, "social");

                for (int partIdx = 0; partIdx < totalParts; partIdx++)
                {
                    job.Cts.Token.ThrowIfCancellationRequested();
                    var chunk = req.items.Skip(partIdx * batchSize).Take(batchSize).ToList();
                    string partFolder = Path.Combine(tempWorkDir, "part_" + (partIdx + 1));
                    string videosFolder = Path.Combine(partFolder, "videos");
                    Directory.CreateDirectory(videosFolder);

                    var partSucceeded = new List<JobItemRequest>();

                    for (int i = 0; i < chunk.Count; i++)
                    {
                        job.Cts.Token.ThrowIfCancellationRequested();
                        var item = chunk[i];
                        int globalIndex = partIdx * batchSize + i + 1;
                        job.stage = string.Format("Baixando {0}/{1} · {2}", globalIndex, job.total, item.shortcode);
                        job.percent = Math.Max(4, Math.Min(85, (int)Math.Round(((globalIndex - 1) / (double)job.total) * 85)));

                        string fileName = string.Format("{0}_{1:D3}_{2}.mp4", safeProfile, globalIndex, SanitizePart(item.shortcode, "video"));
                        string targetFile = Path.Combine(videosFolder, fileName);

                        try
                        {
                            DownloadSingleVideo(item, targetFile);
                            partSucceeded.Add(item);
                            job.completed++;
                            job.completedShortcodes.Add(item.shortcode);
                        }
                        catch (Exception ex)
                        {
                            job.failed++;
                            job.failures.Add(new JobFailure { shortcode = item.shortcode, error = ex.Message });
                        }
                    }

                    if (partSucceeded.Count == 0) continue;

                    string partSuffix = totalParts > 1 ? string.Format("_lote_{0:D2}_de_{1:D2}", partIdx + 1, totalParts) : "";
                    if (req.includeCsv)
                    {
                        string csvPath = Path.Combine(partFolder, string.Format("metricas_{0}{1}.csv", safeProfile, partSuffix));
                        File.WriteAllText(csvPath, BuildCsvContent(req.platform, req.profile, partSucceeded), new UTF8Encoding(true));
                    }

                    if (job.failures.Count > 0)
                    {
                        string failPath = Path.Combine(partFolder, "falhas.txt");
                        string failLines = string.Join(Environment.NewLine, job.failures.Select(f => f.shortcode + ": " + f.error));
                        File.WriteAllText(failPath, failLines, Encoding.UTF8);
                    }

                    job.stage = string.Format("Compactando ZIP {0}/{1}...", partIdx + 1, totalParts);
                    job.percent = 92;

                    string dateStr = DateTime.Now.ToString("yyyy-MM-dd");
                    string zipName = string.Format("JDark_{0}_{1}_{2}{3}.zip", safePlatform, safeProfile, dateStr, partSuffix);
                    string zipFullPath = Path.Combine(outRoot, zipName);
                    if (File.Exists(zipFullPath)) File.Delete(zipFullPath);

                    ZipFile.CreateFromDirectory(partFolder, zipFullPath, CompressionLevel.Fastest, false);
                    job.filenames.Add(zipName);
                }

                if (job.completed == 0)
                {
                    job.status = "error";
                    job.stage = "Falha";
                    job.error = job.failures.Count > 0 ? job.failures[0].error : "Nenhum vídeo pôde ser baixado.";
                }
                else
                {
                    job.status = "complete";
                    job.stage = "Concluído — salvo em Downloads\\J-Dark";
                    job.percent = 100;
                }
            }
            catch (OperationCanceledException)
            {
                job.status = "error";
                job.stage = "Cancelado";
                job.error = "Download cancelado pelo usuário.";
            }
            catch (Exception ex)
            {
                job.status = "error";
                job.stage = "Erro";
                job.error = ex.Message;
            }
            finally
            {
                try { Directory.Delete(tempWorkDir, true); } catch { }
            }
        }

        private static void DownloadSingleVideo(JobItemRequest item, string targetFile)
        {
            string ytDlpPath = FindResourceBinary("yt-dlp.exe");
            string ffmpegPath = FindResourceBinary("ffmpeg.exe");
            string resourceDir = (Path.GetDirectoryName(ffmpegPath) ?? AppDomain.CurrentDomain.BaseDirectory).TrimEnd('\\');
            string lastStderr = "";

            if (File.Exists(ytDlpPath) && !string.IsNullOrWhiteSpace(item.permalink))
            {
                string args = string.Format(
                    "--no-playlist --no-warnings --no-check-certificates --ffmpeg-location \"{0}\" -f \"bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b\" --merge-output-format mp4 -o \"{1}\" \"{2}\"",
                    resourceDir, targetFile, item.permalink
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
                    var errLines = new List<string>();
                    proc.OutputDataReceived += (s, e) => { };
                    proc.ErrorDataReceived += (s, e) =>
                    {
                        if (!string.IsNullOrWhiteSpace(e.Data))
                        {
                            lock (errLines) errLines.Add(e.Data);
                        }
                    };

                    if (proc.Start())
                    {
                        proc.BeginOutputReadLine();
                        proc.BeginErrorReadLine();
                        proc.WaitForExit(180000);
                        if (proc.ExitCode == 0 && File.Exists(targetFile) && new FileInfo(targetFile).Length > 0)
                        {
                            return;
                        }
                        lock (errLines)
                        {
                            if (errLines.Count > 0) lastStderr = errLines[errLines.Count - 1];
                        }
                    }
                }
            }

            if (!string.IsNullOrWhiteSpace(item.videoUrl))
            {
                using (var wc = new WebClient())
                {
                    wc.Headers["User-Agent"] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
                    wc.Headers["Referer"] = !string.IsNullOrWhiteSpace(item.permalink) ? item.permalink : "https://www.tiktok.com/";
                    wc.DownloadFile(item.videoUrl, targetFile);
                    if (File.Exists(targetFile) && new FileInfo(targetFile).Length > 0) return;
                }
            }

            throw new InvalidOperationException(!string.IsNullOrWhiteSpace(lastStderr)
                ? "Falha no yt-dlp: " + lastStderr
                : "Não foi possível baixar o vídeo via yt-dlp nem via URL direta.");
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
