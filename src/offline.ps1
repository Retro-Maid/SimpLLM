# 公開APIと推論サーバーの間でメディア入力を検証する。バックエンドのキーはUIに渡さない。
$offlineSource = @'
using System;
using System.IO;
using System.Net;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Threading;
using System.Net.Sockets;
using System.Web.Script.Serialization;

public sealed class SimpllmOfflineApi : IDisposable {
    readonly TcpListener listener;
    readonly string origin, authority, publicKey, privateKey, backend;
    readonly int backendPort;
    volatile bool backendUp; // 推論サーバーの待ち受けを一度確かめたら、切れるまで調べ直さない
    public volatile string IndexPath; // 画面の HTML (public\index.html)。null なら推論サーバーに任せる
    public SimpllmOfflineApi(int port, int nativePort, string key, string nativeKey) {
        origin = "http://127.0.0.1:" + port;
        authority = new Uri(origin).Authority; // 要求のたびに作り直さない
        backend = "http://127.0.0.1:" + nativePort;
        backendPort = nativePort;
        publicKey = key; privateKey = nativeKey;
        listener = new TcpListener(IPAddress.Loopback, port);
        listener.Start();
        listener.BeginAcceptTcpClient(Accept, null);
    }
    volatile bool disposed;
    // 1 件の受付に失敗しても (接続直後に切られた場合など)、次の受付は必ず続ける。止めるのは終了したときだけ
    void Accept(IAsyncResult ar) {
        TcpClient client = null;
        try { client = listener.EndAcceptTcpClient(ar); } catch { }
        if (disposed) { if (client != null) client.Close(); return; }
        while (true) {
            try { listener.BeginAcceptTcpClient(Accept, null); break; }
            catch (ObjectDisposedException) { if (client != null) client.Close(); return; }
            catch (InvalidOperationException) { if (client != null) client.Close(); return; } // 受付が止まっている
            catch { if (disposed) { if (client != null) client.Close(); return; } Thread.Sleep(50); }
        }
        if (client == null) return;
        ThreadPool.QueueUserWorkItem(delegate {
            using (client) {
                client.ReceiveTimeout = 10000; client.SendTimeout = 30000;
                try { Serve(new LocalContext(client)); } catch { }
            }
        });
    }
    // HTTP.sysや管理者権限を不要にする小さなHTTP/1受付。接続は要求ごとに閉じる。
    // 長さ不明・chunked・重複ヘッダー・絶対URLは受け付けず、要求の解釈を一意にする。
    sealed class LocalRequest {
        public readonly WebHeaderCollection Headers = new WebHeaderCollection();
        public string HttpMethod, RawUrl, ContentType;
        public long ContentLength64;
        public bool HasEntityBody;
        public Uri Url;
        public Stream InputStream;
        static string Line(Stream stream, ref int total) {
            StringBuilder s = new StringBuilder();
            while (true) {
                int b = stream.ReadByte();
                if (b < 0 || ++total > 65536) throw new InvalidDataException();
                if (b == 13) {
                    if (stream.ReadByte() != 10 || ++total > 65536) throw new InvalidDataException();
                    return s.ToString();
                }
                if (b < 32 || b > 126) throw new InvalidDataException();
                s.Append((char)b);
            }
        }
        public LocalRequest(Stream stream) {
            InputStream = stream;
            int total = 0;
            string[] first = Line(stream, ref total).Split(' ');
            if (first.Length != 3 || (first[2] != "HTTP/1.1" && first[2] != "HTTP/1.0") ||
                !first[1].StartsWith("/") || first[1].StartsWith("//") || first[1].Contains("#")) throw new InvalidDataException();
            HttpMethod = first[0]; RawUrl = first[1];
            Url = new Uri("http://127.0.0.1" + RawUrl);
            string line;
            while ((line = Line(stream, ref total)).Length != 0) {
                int colon = line.IndexOf(':');
                if (colon <= 0) throw new InvalidDataException();
                string name = line.Substring(0, colon);
                foreach (char c in name) if (!(Char.IsLetterOrDigit(c) || c == '-')) throw new InvalidDataException();
                if (Headers[name] != null) throw new InvalidDataException();
                Headers.Add(name, line.Substring(colon + 1).Trim());
            }
            if (Headers["Transfer-Encoding"] != null || (Headers["Expect"] != null &&
                !Headers["Expect"].Equals("100-continue", StringComparison.OrdinalIgnoreCase))) throw new InvalidDataException();
            string length = Headers["Content-Length"];
            if (length != null && (!Int64.TryParse(length, out ContentLength64) || ContentLength64 < 0)) throw new InvalidDataException();
            HasEntityBody = ContentLength64 > 0;
            ContentType = Headers["Content-Type"];
        }
    }
    sealed class LocalResponse {
        readonly Stream stream;
        readonly WebHeaderCollection headers = new WebHeaderCollection();
        bool sent;
        public int StatusCode = 200;
        public string ContentType = "application/json";
        public LocalResponse(Stream output) { stream = output; }
        public void AddHeader(string name, string value) { headers[name] = value; }
        public void Continue(byte[] bytes) { stream.Write(bytes, 0, bytes.Length); stream.Flush(); }
        public Stream OutputStream { get { SendHeaders(); return stream; } }
        void SendHeaders() {
            if (sent) return;
            sent = true;
            StringBuilder text = new StringBuilder("HTTP/1.1 " + StatusCode + " Response\r\nConnection: close\r\n");
            text.Append("Content-Type: " + ContentType + "\r\n");
            foreach (string name in headers.AllKeys) text.Append(name + ": " + headers[name] + "\r\n");
            text.Append("\r\n");
            byte[] bytes = Encoding.ASCII.GetBytes(text.ToString()); stream.Write(bytes, 0, bytes.Length);
        }
        public void Close() { SendHeaders(); stream.Close(); }
    }
    sealed class LocalContext {
        public readonly LocalRequest Request;
        public readonly LocalResponse Response;
        public readonly Socket Socket;
        public LocalContext(TcpClient client) {
            Socket = client.Client;
            Stream stream = client.GetStream();
            Response = new LocalResponse(stream);
            try { Request = new LocalRequest(new BufferedStream(stream, 16384)); }
            catch { Error(Response, 400, "Invalid HTTP request framing"); Response.Close(); throw; }
        }
        public void Continue() {
            byte[] interim = Encoding.ASCII.GetBytes("HTTP/1.1 100 Continue\r\n\r\n");
            Response.Continue(interim);
        }
    }
    static bool LocalMedia(object value) {
        string s = value as string;
        if (s != null) return s.StartsWith("data:image/", StringComparison.Ordinal) ||
            s.StartsWith("data:audio/", StringComparison.Ordinal) || s.StartsWith("data:video/", StringComparison.Ordinal);
        IDictionary<string, object> d = value as IDictionary<string, object>;
        if (d == null) return false;
        object url, data;
        bool hasUrl = d.TryGetValue("url", out url), hasData = d.TryGetValue("data", out data);
        return (hasUrl || hasData) && (!hasUrl || LocalMedia(url)) && (!hasData || LocalMedia(data));
    }
    static void Validate(object node) {
        IDictionary<string, object> d = node as IDictionary<string, object>;
        if (d != null) {
            foreach (KeyValuePair<string, object> p in d) {
                // URLはdata形式のみ。文字列本文中のURLは変更しない。
                if (p.Key == "url" || p.Key == "image_url" || p.Key == "input_video" || p.Key == "video_url" || p.Key == "audio_url") {
                    if (!LocalMedia(p.Value)) throw new InvalidDataException();
                }
                if (p.Key == "input_audio") {
                    IDictionary<string, object> a = p.Value as IDictionary<string, object>;
                    object data;
                    if (a == null || !a.TryGetValue("data", out data) || !(data is string)) throw new InvalidDataException();
                    // 上流はinput_audio.dataにもURLを受け付けるため、厳密なbase64だけを許可。
                    try { byte[] decoded = Convert.FromBase64String((string)data); Array.Clear(decoded, 0, decoded.Length); }
                    catch { throw new InvalidDataException(); }
                }
                Validate(p.Value);
            }
        } else {
            IEnumerable list = node as IEnumerable;
            if (list != null && !(node is string)) foreach (object item in list) Validate(item);
        }
    }
    public static void ValidateJson(string json) {
        JavaScriptSerializer parser = new JavaScriptSerializer();
        parser.MaxJsonLength = 32 * 1024 * 1024;
        parser.RecursionLimit = 128;
        Validate(parser.DeserializeObject(json));
    }
    static void Error(LocalResponse response, int status, string message) {
        response.StatusCode = status;
        response.ContentType = "application/json; charset=utf-8";
        byte[] bytes = Encoding.UTF8.GetBytes("{\"error\":\"" + message + "\"}");
        response.OutputStream.Write(bytes, 0, bytes.Length);
    }
    static void DrainSmall(LocalRequest req) {
        if (req.ContentLength64 <= 0 || req.ContentLength64 > 65536 || req.Headers["Expect"] != null) return;
        byte[] buffer = new byte[1024];
        try {
            long left = req.ContentLength64;
            while (left > 0) { int count = req.InputStream.Read(buffer, 0, (int)Math.Min(left, buffer.Length)); if (count == 0) break; left -= count; }
        } catch { } finally { Array.Clear(buffer, 0, buffer.Length); }
    }
    // 画面側が接続を切ったか (停止ボタン・閉じる)。要求の本文は読み終えているので、読めるのに中身が無ければ切断
    static bool ClientGone(Socket socket) {
        try { return socket.Poll(0, SelectMode.SelectRead) && socket.Available == 0; } catch { return true; }
    }
    // 推論サーバーが待ち受けているか。待ち受け前に接続を試すと、Windows が再送の間隔 (0.5〜1 秒) でしか
    // 気付かない (実測: 待ち受けてから 0.3〜0.5 秒遅れる)。待ち受けの一覧なら数ミリ秒で分かる
    bool BackendListening() {
        if (backendUp) return true;
        try {
            foreach (IPEndPoint e in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners()) {
                if (e.Port == backendPort) { backendUp = true; return true; }
            }
            return false;
        } catch { return true; } // 調べられないときは、これまでどおり接続を試す
    }
    void Serve(LocalContext ctx) {
        byte[] body = null;
        Timer watchdog = null;
        try {
            LocalRequest req = ctx.Request;
            if (req.Headers["Host"] != authority) { DrainSmall(req); Error(ctx.Response, 403, "Invalid host"); return; }
            string from = req.Headers["Origin"];
            if (!String.IsNullOrEmpty(from) && from != origin) { DrainSmall(req); Error(ctx.Response, 403, "Invalid origin"); return; }
            if (from == origin) ctx.Response.AddHeader("Access-Control-Allow-Origin", origin);
            if (req.HttpMethod == "OPTIONS") {
                ctx.Response.AddHeader("Access-Control-Allow-Methods", "GET,POST");
                ctx.Response.AddHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
                ctx.Response.StatusCode = 204; return;
            }
            string path = req.Url.AbsolutePath;
            bool anonymous = req.HttpMethod == "GET" && (path == "/" || path == "/index.html" || path == "/health");
            if (!anonymous && req.Headers["Authorization"] != "Bearer " + publicKey) { DrainSmall(req); Error(ctx.Response, 401, "Unauthorized"); return; }
            if (req.HttpMethod != "GET" && req.HttpMethod != "POST") { Error(ctx.Response, 405, "Method not allowed"); return; }
            // 画面の HTML はここで返す。推論サーバーの起動を待たずに、読み込み中のロゴを出せる
            // (推論サーバーに日本語を含むフォルダのパスを渡さずに済む)。毎回読むので、-BuildOnly で作り直した内容もすぐ反映される
            string index = IndexPath;
            if (req.HttpMethod == "GET" && (path == "/" || path == "/index.html") && index != null && File.Exists(index)) {
                byte[] page = File.ReadAllBytes(index);
                ctx.Response.ContentType = "text/html; charset=utf-8";
                ctx.Response.AddHeader("Cache-Control", "no-store");
                ctx.Response.AddHeader("X-Content-Type-Options", "nosniff");
                ctx.Response.AddHeader("Content-Length", page.Length.ToString());
                ctx.Response.OutputStream.Write(page, 0, page.Length);
                return;
            }
            if (req.HasEntityBody) {
                if (req.ContentLength64 <= 0 || req.ContentLength64 > 32 * 1024 * 1024 ||
                    req.ContentType == null || !req.ContentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase)) {
                    Error(ctx.Response, 400, "Expected bounded JSON body"); return;
                }
                if (req.Headers["Expect"] != null) {
                    ctx.Continue();
                }
                body = new byte[(int)req.ContentLength64];
                int offset = 0;
                while (offset < body.Length) {
                    int count = req.InputStream.Read(body, offset, body.Length - offset);
                    if (count == 0) throw new InvalidDataException();
                    offset += count;
                }
                ValidateJson(new UTF8Encoding(false, true).GetString(body));
            }
            HttpWebRequest upstream = null;
            // 入力の処理中 (応答の最初の1バイトが来る前) に止められても推論を続けないよう、切断を見張って中止する
            watchdog = new Timer(delegate { HttpWebRequest current = upstream; if (current != null && ClientGone(ctx.Socket)) current.Abort(); }, null, 500, 500);
            HttpWebResponse remote;
            // 推論サーバーの起動を待たずにブラウザを開くので、待ち受け前の依頼は少し待って送り直す (上限は念のため)
            DateTime connectUntil = DateTime.UtcNow.AddMinutes(10); // HDD からの冷えた起動は数十秒かかりうる。サーバーが落ちたら終了処理で止まり、画面を閉じたら ClientGone で止まる
            while (true) {
                while (!BackendListening() && !disposed && DateTime.UtcNow < connectUntil && !ClientGone(ctx.Socket)) Thread.Sleep(50);
                upstream = (HttpWebRequest)WebRequest.Create(backend + req.RawUrl);
                upstream.Proxy = null; upstream.AllowAutoRedirect = false;
                upstream.CachePolicy = new System.Net.Cache.RequestCachePolicy(System.Net.Cache.RequestCacheLevel.NoCacheNoStore);
                upstream.ServicePoint.Expect100Continue = false;
                upstream.ServicePoint.ConnectionLimit = 64;
                upstream.Method = req.HttpMethod; upstream.Timeout = 1200000; upstream.ReadWriteTimeout = 1200000;
                upstream.Headers["Authorization"] = "Bearer " + privateKey;
                try {
                    if (body != null) {
                        upstream.ContentType = "application/json"; upstream.ContentLength = body.Length;
                        using (Stream output = upstream.GetRequestStream()) output.Write(body, 0, body.Length);
                    }
                    remote = (HttpWebResponse)upstream.GetResponse();
                    break;
                } catch (WebException e) {
                    if (e.Status == WebExceptionStatus.ConnectFailure) backendUp = false; // 入れ替え中。次は待ち受けを確かめてから送る
                    if (e.Status == WebExceptionStatus.ConnectFailure && !disposed && DateTime.UtcNow < connectUntil && !ClientGone(ctx.Socket)) {
                        Thread.Sleep(100);
                        continue;
                    }
                    remote = e.Response as HttpWebResponse;
                    if (remote == null) throw;
                    break;
                }
            }
            using (remote) {
                ctx.Response.StatusCode = (int)remote.StatusCode;
                ctx.Response.ContentType = remote.ContentType;
                ctx.Response.AddHeader("Cache-Control", "no-store");
                byte[] buffer = new byte[8192];
                try {
                    using (Stream input = remote.GetResponseStream()) {
                        int count;
                        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                            try {
                                ctx.Response.OutputStream.Write(buffer, 0, count);
                                ctx.Response.OutputStream.Flush();
                            } catch {
                                // 画面側が止めた (停止ボタン・閉じる)。ここで接続を切らないと、.NET Framework は
                                // 閉じるときに残りを最後まで読むので、llama-server は生成を続けてしまう (次の依頼が待たされる)
                                upstream.Abort();
                                throw;
                            }
                        }
                    }
                } finally { Array.Clear(buffer, 0, buffer.Length); }
            }
        } catch (InvalidDataException) { try { Error(ctx.Response, 400, "Only inline media data is allowed"); } catch { } }
        catch (ArgumentException) { try { Error(ctx.Response, 400, "Invalid JSON"); } catch { } }
        catch (InvalidOperationException) { try { Error(ctx.Response, 400, "Invalid JSON"); } catch { } }
        catch { try { Error(ctx.Response, 502, "Local inference request failed"); } catch { } }
        finally {
            if (watchdog != null) watchdog.Dispose();
            if (body != null) Array.Clear(body, 0, body.Length);
            try { ctx.Response.Close(); } catch { }
        }
    }
    public void Dispose() { disposed = true; listener.Stop(); }
}
'@
Import-CSharp 'SimpllmOfflineApi' $offlineSource @('System.Web.Extensions.dll')
