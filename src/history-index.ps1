# Rebuildable per-chat summaries and image-reference sets. Attributes are durable,
# separate files so renaming a conversation never rewrites its attachments.
$historyIndexSource = @'
using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
public sealed class SimpllmHistoryIndex {
    readonly string root;
    readonly Dictionary<string, Entry> cache = new Dictionary<string, Entry>();
    static readonly Regex Ref = new Regex(@"simpllm-img:([0-9a-f]{64}\.(?:png|jpg|webp|gif))");
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    public sealed class Entry {
        public long bytes, ticks;
        public Dictionary<string, object> summary;
        public string[] refs;
    }
    static JavaScriptSerializer Parser() { return new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024, RecursionLimit = 128 }; }
    static void CollectRefs(object value, HashSet<string> names) {
        string text = value as string;
        if (text != null) { foreach (Match m in Ref.Matches(text)) names.Add(m.Groups[1].Value); return; }
        var dict = value as IDictionary<string, object>;
        if (dict != null) { foreach (object item in dict.Values) CollectRefs(item,names); return; }
        var list = value as IEnumerable;
        if (list != null) foreach (object item in list) CollectRefs(item,names);
    }
    public SimpllmHistoryIndex(string dir) { root = dir; }
    static object Value(Dictionary<string, object> d, string k, object fallback) { object v; return d.TryGetValue(k, out v) ? v : fallback; }
    public void Forget(string id) { cache.Remove(id); }
    public Entry Get(string id) {
        string path = Path.Combine(root, "chats", id + ".json");
        var f = new FileInfo(path);
        if (!f.Exists || f.Length > 64 * 1024 * 1024) throw new InvalidDataException();
        Entry e;
        if (!cache.TryGetValue(id, out e) || e.bytes != f.Length || e.ticks != f.LastWriteTimeUtc.Ticks) {
            string stored = Path.Combine(root, "index", id + ".json");
            e = null;
            try {
                var candidate = Parser().Deserialize<Entry>(File.ReadAllText(stored, Utf8));
                if (candidate.bytes == f.Length && candidate.ticks == f.LastWriteTimeUtc.Ticks && candidate.summary != null && candidate.refs != null &&
                    Convert.ToString(Value(candidate.summary, "id", "")) == id && candidate.summary.ContainsKey("messageCount")) e = candidate;
            } catch { }
            if (e == null) {
                string text = File.ReadAllText(path, Utf8);
                var data = Parser().DeserializeObject(text) as Dictionary<string, object>;
                if (data == null || Convert.ToString(Value(data,"id","")) != id) throw new InvalidDataException();
                var messages = Value(data, "messages", null) as ICollection;
                if (messages == null) throw new InvalidDataException();
                var summary = new Dictionary<string, object>();
                foreach (string k in new [] { "id", "title", "createdAt", "updatedAt", "pinned", "folder" }) summary[k] = Value(data,k,null);
                summary["format"] = "simpllm-chat-summary"; summary["messageCount"] = messages.Count;
                var names = new HashSet<string>(); CollectRefs(data,names);
                summary["hasImages"] = names.Count > 0;
                e = new Entry { bytes = f.Length, ticks = f.LastWriteTimeUtc.Ticks, summary = summary, refs = new List<string>(names).ToArray() };
                try { Directory.CreateDirectory(Path.GetDirectoryName(stored)); File.WriteAllText(stored + ".tmp", Parser().Serialize(e), Utf8);
                    if (File.Exists(stored)) File.Replace(stored + ".tmp", stored, null); else File.Move(stored + ".tmp", stored); } catch { }
            }
            cache[id] = e;
        }
        return e;
    }
    // The attribute file is a small sidecar. If it cannot be read, the conversation falls back to
    // the values in its body instead of disappearing from the list.
    static Dictionary<string, object> Attributes(string path) {
        try { if (File.Exists(path)) return Parser().DeserializeObject(File.ReadAllText(path, Utf8)) as Dictionary<string, object>; } catch { }
        return null;
    }
    public string Summary(string id) {
        var summary = new Dictionary<string, object>(Get(id).summary);
        var d = Attributes(Path.Combine(root,"attributes",id+".json"));
        if (d != null) foreach (string k in new [] { "title", "updatedAt", "pinned", "folder" }) if (d.ContainsKey(k)) summary[k] = d[k];
        return Parser().Serialize(summary);
    }
    // A term without characters that JSON escapes appears in the file exactly as typed.
    static bool Literal(string term) {
        foreach (char c in term) if (c == '"' || c == '\\' || c < ' ') return false;
        return true;
    }
    public bool Matches(string id, string query, bool words) {
        string text = File.ReadAllText(Path.Combine(root,"chats",id+".json"), Utf8);
        string[] terms = words ? Regex.Split(query.Trim(), @"\s+") : new [] { query };
        // Most conversations do not contain the query at all: rule them out on the raw text and
        // skip the JSON parse. Files with \u escapes are parsed, since the raw text may differ.
        if (text.IndexOf("\\u", StringComparison.Ordinal) < 0) {
            foreach (string term in terms) if (Literal(term) && text.IndexOf(term, StringComparison.OrdinalIgnoreCase) < 0) return false;
        }
        var data = Parser().DeserializeObject(text) as Dictionary<string, object>;
        if (data == null) return false;
        var list = Value(data,"messages",null) as IEnumerable;
        if (list == null) return false;
        foreach (object raw in list) {
            var m = raw as Dictionary<string, object>;
            if (m == null || Convert.ToString(Value(m,"role","")) == "image") continue;
            string content = Convert.ToString(Value(m,"content",""));
            bool match = true; foreach (string term in terms) if (content.IndexOf(term,StringComparison.OrdinalIgnoreCase) < 0) { match=false; break; }
            if (match) return true;
        }
        return false;
    }
    public byte[] Full(string id) {
        string path = Path.Combine(root,"chats",id+".json"), attrs = Path.Combine(root,"attributes",id+".json");
        var updates = Attributes(attrs);
        if (updates == null) return File.ReadAllBytes(path);
        var parser = Parser();
        var data = parser.DeserializeObject(File.ReadAllText(path,Utf8)) as Dictionary<string, object>;
        if (data == null) throw new InvalidDataException();
        foreach (string k in new [] { "title", "updatedAt", "pinned", "folder" }) if (updates.ContainsKey(k)) data[k] = updates[k];
        return Utf8.GetBytes(parser.Serialize(data));
    }
}
'@
if (-not ('SimpllmHistoryIndex' -as [type])) {
    if (Get-Command Import-CSharp -ErrorAction SilentlyContinue) { Import-CSharp 'SimpllmHistoryIndex' $historyIndexSource @('System.Web.Extensions.dll') }
    else { Add-Type -TypeDefinition $historyIndexSource -ReferencedAssemblies 'System.Web.Extensions.dll' }
}
$script:historyIndex = $null
function Get-HistoryIndex {
    if ($null -eq $script:historyIndex -or $script:historyIndexRoot -cne $historyDir) {
        $script:historyIndex = [SimpllmHistoryIndex]::new($historyDir)
        $script:historyIndexRoot = $historyDir
    }
    return $script:historyIndex
}
# 1 行目に設定 (無ければ null)、続いて (あれば) プロジェクト、会話の要約を 1 件ずつ (読めない会話は {} の行。UI が件数を知らせる)。
# 設定・プロジェクトが読めないときは一覧を返さない (UI が初期値や空のプロジェクトで上書きしないように)。
# 起動時の片付けもここで行う: 同じ読み込みで集めた参照から、使われていない画像を消す (読めない会話が 1 つでもあれば、何も消さない)
function Get-HistoryIndexBytes {
    Assert-HistoryReady
    $lines = [Collections.Generic.List[byte[]]]::new()
    foreach ($path in @($historyMeta, (Get-HistoryProjectsPath))) {
        if ([IO.File]::Exists($path)) {
            try { $lines.Add((ConvertTo-HistoryLineBytes ([IO.File]::ReadAllBytes($path)))) }
            catch { throw (L 'history.metaUnreadable' @{ error = $_.Exception.Message }) }
        }
        elseif ($path -eq $historyMeta) { $lines.Add($historyNullLine) }
    }
    $index = Get-HistoryIndex
    $used = [Collections.Generic.HashSet[string]]::new()
    $complete = $true
    foreach ($file in [IO.Directory]::EnumerateFiles($historyChats, '*.json')) {
        $id = [IO.Path]::GetFileNameWithoutExtension($file)
        if (-not (Test-HistoryChatId $id)) { continue }
        try {
            foreach ($name in $index.Get($id).refs) { [void]$used.Add($name) }
            $lines.Add($historyUtf8.GetBytes($index.Summary($id)))
        } catch { $complete = $false; $lines.Add($historyUtf8.GetBytes('{}')) }
    }
    if ($complete -and @([IO.Directory]::GetFiles($historyImages)).Count -gt 0) { [void](Remove-UnusedHistoryImages $used) }
    return ,(Join-HistoryLines $lines)
}
function Get-IndexedHistoryImages {
    $used = [Collections.Generic.HashSet[string]]::new()
    $index = Get-HistoryIndex
    foreach ($file in [IO.Directory]::EnumerateFiles($historyChats, '*.json')) {
        $id = [IO.Path]::GetFileNameWithoutExtension($file)
        if (-not (Test-HistoryChatId $id)) { continue }
        try { foreach ($name in $index.Get($id).refs) { [void]$used.Add($name) } } catch { return $null }
    }
    return ,$used
}
function Save-HistoryAttributes([string]$id, [byte[]]$bytes) {
    Assert-HistoryReady
    if (-not (Test-HistoryChatId $id)) { throw (L 'history.badId') }
    if (-not [IO.File]::Exists((Join-Path $historyChats "$id.json"))) { throw (L 'history.badId') }
    $data = $historyUtf8.GetString($bytes) | ConvertFrom-Json
    if ($data.title -isnot [string] -or $data.title.Length -gt 200 -or $data.folder -isnot [string] -or $data.folder.Length -gt 60 -or $data.pinned -isnot [bool]) { throw (L 'history.badChat') }
    $dir = Join-Path $historyDir 'attributes'
    [void][IO.Directory]::CreateDirectory($dir)
    Write-HistoryFile (Join-Path $dir "$id.json") $bytes
}
