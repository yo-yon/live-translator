# 登壇翻訳 LIVE — サーバー版の構築手順（Azure Static Web Apps）

キーをブラウザに入れずに使えるサーバー版です。各自が **自分の Azure** に構築し、料金も各自のサブスクリプションにかかります。所要時間の目安は 45〜60 分です。

- 各手順の最後の **「✅ 確認」** ができてから次に進んでください
- キーや接続文字列はパスワードと同じです。チャット・メール・GitHub のファイルには貼らないでください
- GitHub Pages 版（キーを画面に入力する版）は、これまでどおり https://yo-yon.github.io/live-translator/ で使えます。同じ画面のファイルが、置き場所に応じて自動でサーバー版かキー入力版かを切り替えます

## 0. 全体像と費用

| リソース | プラン | 用途 | 費用 |
|---|---|---|---|
| リソースグループ | — | まとめて管理・削除するための入れ物 | 0円 |
| Static Web Apps | **Free** | 画面と API（キーを持つのはここだけ） | 0円 |
| ストレージアカウント | Standard / LRS | 👎・ご意見・送られた字幕ログの保存 | ごく少額（単価は未確認） |
| Speech（またはマルチサービスの Foundry リソース） | S0 | 音声認識（約 $1/時）、機械翻訳の代替、読み上げ | 使った分 |
| Foundry の gpt-5.4-mini | Global Standard | 翻訳 | 使った分 |

Speech と Foundry の作り方は [README.md](README.md) の「Azure の準備」と同じです。すでに GitHub Pages 版で使っているキーをそのまま使えます。

## 1. リポジトリを自分の GitHub に用意する

1. https://github.com/yo-yon/live-translator を開き、右上の **Fork** を選ぶ
2. Owner を自分のアカウントにして **Create fork**

✅ 確認：自分のアカウントに `live-translator` があり、`api` フォルダと `staticwebapp.config.json` が見える

> 更新を取り込むときは、フォークの画面で **Sync fork** →**Update branch** を押します。

## 2. ストレージアカウントを作る

1. Azure ポータルの検索欄に「ストレージ アカウント」と入力して開き、**＋ 作成**
2. リソースグループ（例：`rg-live-translator`）、名前（英小文字と数字・3〜24文字・世界で重複不可）、リージョン、**Standard**、**ローカル冗長ストレージ (LRS)** を選んで作成
3. 作成後、**セキュリティとネットワーク** →**アクセス キー** →**キーの表示** →key1 の **接続文字列** をコピーして控える

✅ 確認：控えた文字列が `DefaultEndpointsProtocol=https;AccountName=` で始まる

## 3. Static Web Apps を作る

1. 検索欄に「Static Web Apps」と入力し、**静的 Web アプリ** →**＋ 作成**
2. 次のとおり入力する

   | 項目 | 値 |
   |---|---|
   | プランの種類 | **Free** |
   | ソース | **GitHub**（サインインして許可） |
   | リポジトリ／ブランチ | 手順1のフォーク／`main` |
   | ビルドのプリセット | **Custom** |
   | アプリの場所 | `/` |
   | API の場所 | `api` |
   | 出力先 | 空欄 |

3. **確認および作成** →**作成**。GitHub の **Actions** タブで最初のデプロイが緑のチェックになるまで待つ（数分）
4. Static Web Apps の **概要** にある **URL** を控える

✅ 確認：URL を開くと Microsoft のサインイン画面に移る（まだ中には入れなくて正常）

## 4. 環境変数（キー類）を登録する

Static Web Apps の **設定** →**環境変数**（環境は **運用**）で、次を1つずつ追加し、最後に画面下の **適用** を押します。

| 名前 | 値 | 必須 |
|---|---|---|
| `SPEECH_KEY` | Speech（またはマルチサービス）のキー | ✅ |
| `SPEECH_REGION` | そのリソースのリージョン（例：`eastus`。小文字・スペースなし） | ✅ |
| `FOUNDRY_ENDPOINT` | `https://<リソース名>.openai.azure.com`（末尾の `/openai/v1` は不要） | LLM 翻訳に必要 |
| `FOUNDRY_API_KEY` | Foundry のキー | LLM 翻訳に必要 |
| `FOUNDRY_DEPLOYMENT` | デプロイ名（例：`gpt-5.4-mini`） | 任意 |
| `STORAGE_CONNECTION_STRING` | 手順2の接続文字列 | 👎・ご意見に必要 |
| `CENTRAL_URL` | 中央の受け口の URL（作者から受け取る） | 任意 |
| `CENTRAL_KEY` | 中央の受け口の鍵（作者から受け取る） | 任意 |

- `CENTRAL_URL` と `CENTRAL_KEY` を入れると、👎・ご意見がツールの作者にも届き、改善に使われます。入れなければ、自分のストレージだけに保存されます
- 字幕ログは、利用者が設定画面で「改善のため、終了時に字幕ログを送る」をオンにしたときだけ送られます

✅ 確認：一覧に名前が並び、値の前後に空白がない

## 5. 使う人を招待する（ロール）

このアプリは、招待した人（ロール `owner` または `member`）だけが使えます。

1. Static Web Apps の **設定** →**ロール管理** →**招待**
2. 認証プロバイダー **Microsoft Entra ID**、招待先のメールアドレス、ロール `owner`（自分）または `member`（ほかの人）、有効期限（最大168時間）を入れて **生成**
3. 招待リンクを本人に渡し、サインインに使うのと同じブラウザで開いてもらう

- 招待で付けられるのは 25 人までです（Free・Standard 共通）

✅ 確認：手順3の URL を開くと画面が出て、上部に「サーバー版：キーの入力は不要です」と出る。設定画面にキーの入力欄が出ない

## 6. 動作確認

- [ ] 「開始」で翻訳が始まり、字幕が出る（PC と iPhone）
- [ ] 15 分以上続けても止まらない（Speech のトークンは10分で切れるため、自動で取り直しています）
- [ ] 字幕ログの 👎 から送ると「フィードバックを送りました」と出る
- [ ] ヘッダーの 💬 から、ご意見を送れる
- [ ] 設定画面の版番号が、GitHub の最新と同じ

## 困ったとき

| 症状 | 確認すること |
|---|---|
| 「Speech のトークンを取得できません（HTTP 500）」 | `SPEECH_KEY` / `SPEECH_REGION` |
| 「Speech のトークンを取得できません（HTTP 502）」 | キーとリージョンが同じリソースのものか |
| 訳に「・機械翻訳」が付き続ける | `FOUNDRY_ENDPOINT` / `FOUNDRY_API_KEY` / `FOUNDRY_DEPLOYMENT` |
| 👎 で「送れませんでした」 | `STORAGE_CONNECTION_STRING`、手順4の最後の「適用」 |
| サインイン後に「アクセスできません」 | 手順5の招待を同じアカウントで受けたか。ロール名は小文字 |
| キー入力の画面になる | URL が Static Web Apps のものか（GitHub Pages の URL ではないか） |

## 参考（公式）

- [Quickstart: Build your first static web app（Azure ポータル）](https://learn.microsoft.com/azure/static-web-apps/get-started-portal)
- [Configure application settings（環境変数）](https://learn.microsoft.com/azure/static-web-apps/application-settings)
- [Custom authentication（ロール管理・招待）](https://learn.microsoft.com/azure/static-web-apps/authentication-custom#manage-roles)
- [Quotas in Azure Static Web Apps（招待は25人まで）](https://learn.microsoft.com/azure/static-web-apps/quotas)
- [SpeechConfig.fromAuthorizationToken（トークンの更新）](https://learn.microsoft.com/javascript/api/microsoft-cognitiveservices-speech-sdk/speechconfig)
