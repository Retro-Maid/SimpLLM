# 変更履歴

SimpLLM の版ごとの変更をまとめています。版の番号は [セマンティックバージョニング](https://semver.org/lang/ja/) に従います。いま使っている版は、設定の「情報」で確かめられます。

## 版の番号の付け方

版の番号は「MAJOR.MINOR.PATCH」の 3 つの数です。次の 4 つを、版をまたいで守る約束とします。

1. **保存したデータ**: `history\` の会話・設定・プロジェクトと、JSON での書き出し。新しい版でも、古い版のデータをそのまま読める
2. **起動時の引数**: `start.bat` の `-Model`・`-Context`・`-Vision`・`-NoBrowser` など
3. **フォルダの置き方**: `bin\`・`models\`（`chat\`・`image\`）、`models.json`、`.run\model-settings.json`
4. **動作環境**: Windows 10（1809 以降）・PowerShell 5.1・Chrome か Edge

| 上げる数 | どんなとき |
|---|---|
| MAJOR | 上の約束を破るとき（古い履歴を読めなくなる、引数をなくす、フォルダの置き方を変える、など） |
| MINOR | 約束を守ったまま機能を足すとき。動作を確かめた llama.cpp の版を上げるときもここに入れ、`bin\` の入れ替えが必要なら書いておく |
| PATCH | 不具合の修正、速さの改善、訳文の直し |

画面の見た目や文言、画面と起動スクリプトの間のやり取りは約束に含めません。README や画像だけの変更では版を上げません。試しに出す版は `1.1.0-beta.1` のように後ろに付けます。

## [1.1.0] - 未公開

### 追加

- 設定に「情報」を追加。SimpLLM の版、作成者、ライセンス、ソースコードの場所、使っている llama.cpp の版を表示する
- 使っている llama.cpp が、動作を確かめた版（b11669）より古いときに知らせる。サーバーが返す版を読むだけなので、起動は遅くならない
- 版の番号を `src\version.txt` の 1 か所にまとめた。起動の記録（`.run\last-session.log`）にも版を書く

### 変更

- README の比較表を、LM Studio・Ollama との比較に絞って書き直した
- 画像の生成・編集に使う stable-diffusion.cpp と画像モデルの入れ方を、README・`bin/README.md`・`models/README.md` に書いた（動作を確かめた版: master-1031-c6dfa9d）

## [1.0.0] - 2026-11-17

最初の公開版。

- チャット（再生成・編集・分岐、モデルの切り替え、システムプロンプトの登録）
- テキスト・PDF・画像の添付
- 会話・画像・設定の自動保存、フォルダ分け、検索、JSON と Markdown での書き出し
- 画像の生成・編集（stable-diffusion.cpp と画像モデルを置いたとき）
- 表示言語: 日本語・英語・簡体字中国語・繁体字中国語・韓国語・ドイツ語
- 動作を確かめた llama.cpp: b11669

[1.1.0]: https://github.com/Retro-Maid/SimpLLM/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Retro-Maid/SimpLLM/releases/tag/v1.0.0
