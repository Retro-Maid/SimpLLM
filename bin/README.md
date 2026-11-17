# bin

ここに llama.cpp を入れます（安全のため、同梱せず、公式の配布元から自分で入手する方式にしています）。

1. [llama.cpp のリリース](https://github.com/ggml-org/llama.cpp/releases) から、次の 2 つの zip をダウンロードします（動作を確認した版: b11669）。
   - `llama-<版>-bin-win-cuda-12.4-x64.zip`
   - `cudart-llama-bin-win-cuda-12.4-x64.zip`
2. リリースのページに書かれた SHA256 と照合します（PowerShell で `Get-FileHash <zip のパス> -Algorithm SHA256`）。
3. 2 つの zip を展開し、中身（`llama-server.exe` と `.dll`）を、フォルダごとではなく、この `bin` の直下に入れます。

フォルダごと入れた・2 つ目の zip を入れ忘れたときは、起動時に知らせます。

画像の生成・編集を使うときは、stable-diffusion.cpp の `sd-cli.exe` 一式を `bin\sd\` に入れます。
