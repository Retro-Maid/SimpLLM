# bin

ここに llama.cpp を入れます（安全のため、同梱せず、公式の配布元から自分で入手する方式にしています）。

1. [llama.cpp のリリース](https://github.com/ggml-org/llama.cpp/releases) から、次の 2 つの zip をダウンロードします（動作を確認した版: b11669）。
   - `llama-<版>-bin-win-cuda-12.4-x64.zip`
   - `cudart-llama-bin-win-cuda-12.4-x64.zip`
2. リリースのページに書かれた SHA256 と照合します（PowerShell で `Get-FileHash <zip のパス> -Algorithm SHA256`）。
3. 2 つの zip を展開し、中身（`llama-server.exe` と `.dll`）を、フォルダごとではなく、この `bin` の直下に入れます。

フォルダごと入れた・2 つ目の zip を入れ忘れたときは、起動時に知らせます。

## 画像の生成・編集を使うとき（任意）

画像は llama.cpp ではなく stable-diffusion.cpp で作ります。使わないなら入れなくてかまいません。

1. [stable-diffusion.cpp のリリース](https://github.com/leejet/stable-diffusion.cpp/releases) から、次の 2 つの zip をダウンロードします（動作を確認した版: master-1031-c6dfa9d）。
   - `sd-master-<版>-bin-win-cuda12-x64.zip`
   - `cudart-sd-bin-win-cu12-x64.zip`
2. llama.cpp と同じく、SHA256 を照合します。
3. 2 つの zip を展開し、中身（`sd-cli.exe` と `.dll`）を `bin\sd\` に入れます。`bin` の直下ではありません（llama.cpp の `.dll` と混ざらないよう分けています）。

```
bin\
├─ llama-server.exe など   ← llama.cpp
└─ sd\
    └─ sd-cli.exe など     ← stable-diffusion.cpp
```

`sd-server.exe` は使いません。画像モデルの置き方は [models/README.md](../models/README.md) にあります。

stable-diffusion.cpp も llama.cpp も、SimpLLM には同梱していません。どちらも MIT ライセンスで、入手した zip に含まれるライセンスに従います。
