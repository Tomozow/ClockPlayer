# Clock Player 構成仕様書

本仕様書は、時間帯（深夜・朝・昼・夜など）に応じて再生する BGM フォルダを自動で切り替える、時計付きミュージックプレイヤー「Clock Player」の構成をまとめたものです。0.2 系の実装に合わせています。

## 1. 概要

Clock Player には、同じ画面のコードで動く2つの版があります。

| | ローカル版 | GitHub Pages 版 |
| --- | --- | --- |
| 入手 | Releases の `ClockPlayer-v<版>.zip` を展開する | `https://tomozow.github.io/ClockPlayer/` を開く |
| 配信 | 同梱の PowerShell サーバーが `http://127.0.0.1:<ポート>/` で配信 | GitHub Pages |
| 曲の置き場 | ダウンロードしたフォルダの `bgm/bgmA`〜`bgmF` | ブラウザの保存領域（Origin Private File System） |
| 設定・プリセット | `data/` のファイル | localStorage |
| 消える可能性 | なし（ディスク上のファイル） | ディスクの空きが少ないとブラウザが消すことがある |

- **フロントエンド**: HTML5、CSS3、JavaScript（Vanilla ES6）。ビルドの工程は無い
- **サーバー（ローカル版のみ）**: Windows 標準の PowerShell 5.1 だけで動く。外部のモジュールや追加のインストールは不要（ゼロデペンデンシー）
- **OBS 連携**: 設定パネルを OBS の「カスタムブラウザドック」、プレイヤーを「ブラウザソース」に読み込み、ドックで操作・設定し、ブラウザソースで音を鳴らす

---

## 2. アーキテクチャ

### 2.1 ローカルサーバー（`server.ps1`）

- **待ち受け**: `System.Net.Sockets.TcpListener` で `127.0.0.1` だけを待ち受ける。HttpListener（http.sys）は管理者権限や URL 予約を求められることがあるため使わない
- **ポート**: 初期設定は 8137。使用中なら 8138〜8146 を順に試す。初期設定は `data/server.json` の `port` で変えられる。実際に使ったポートは `data/port.js` に `window.clockPlayerPort = <ポート>;` として書き出す
- **同時処理**: 接続ごとに RunspacePool（最大 32）の runspace で処理する。曲の配信中もドックの操作が止まらない
- **HTTP**: 1回の接続で1つの要求に応え、`Connection: close` で閉じる。応答には `Cache-Control: no-store` を付ける。音声のシークのための `Range: bytes=開始-終了` に `206 Partial Content` で応える
- **安全対策**
  - `Host` 見出しが `127.0.0.1:<ポート>` か `localhost:<ポート>` 以外なら 403 を返す（DNS リバインディング対策）
  - `/api/` 以下は独自の見出し `X-ClockPlayer: 1` を求める。他のサイトからの fetch は事前確認（preflight）で止まり、サーバーはその確認に応えない
  - 静的ファイルは、アプリのフォルダの中だけを配信する。`data/` と、名前が `.` で始まるもの（隠しファイル、`..`）は配信しない
- **二重起動の防止**: 起動時に `data/port.js` のポートへ `/api/ping.js` を問い合わせ、Clock Player が応答すれば起動せずに URL だけを表示する
- **停止**: `-Stop` を付けて実行すると、`data/server.pid` のプロセス（powershell / pwsh に限る）を止める

### 2.2 データの置き場（ローカル版）

| パス | 内容 |
| --- | --- |
| `bgm/bgmA`〜`bgmF` | 曲（サブフォルダも可） |
| `data/config.json` | 設定（時間帯・シャッフル・音量・OBS 向けの表示設定） |
| `data/presets.json` | プリセット |
| `data/manifest.json` | 曲リスト（`{ bgmA: [{ name, path, artist, title }], ... }`） |
| `data/server.json` | 初期設定のポート |
| `data/port.js` / `data/server.pid` | 起動中のポートとプロセス番号 |
| `data/server.log` | バックグラウンド起動時のログ |

- ファイルの書き込みは、一時ファイルに書いてから置き換える（書きかけのファイルを残さない）
- 曲リストの読み書きは、サーバー内の1つのロックで順番に行う
- 曲リストは、サーバーの起動時と「再読み込み」で `bgm` フォルダを走査して作り直す。既に記録のある曲は記録をそのまま使い、新しい曲だけ曲名を読む。曲名は、ファイル名が「アーティスト - 曲名」ならそれを使い、そうでなければ Windows のエクスプローラーの曲情報（Shell.Application）から読む

### 2.3 画面とデータの受け渡し

- `config.js` はサーバーが組み立てて返す。中身は次のとおり
  - `window.clockServer`: ポート、ブラウザソースに登録するファイルのパス、ドックに登録する `file:///` の URL
  - `window.bgmClockConfig`: `data/config.json`。無ければ配布物の `config.js`（既定のスケジュール）
  - `window.bgmClockPresets`: `data/presets.json`。無ければ `null`
- 画面側は `window.clockServer` の有無でローカル版か GitHub Pages 版かを見分け、`library.js` の `ClockLibrary` を切り替える。どちらも同じ関数（曲リストの読み込み、取り込み、削除、使用量、再生用 URL など）をそろえており、`index.js` からは区別せずに使う
- **ドックとブラウザソースの同期**: どちらも同じオリジン（ローカル版は `http://127.0.0.1:<ポート>`）で開かれるので、BroadcastChannel（`clockplayer-sync`）と localStorage を共有する
  - ブラウザソース（`obs.html`）が再生役で、再生状態を約1秒ごとに送る
  - ドック（`index.html?dock`）は操作役で、再生・一時停止・曲送り・シーク・音量・選曲の命令を送る。再生役が見つかっている間、ドックは音を鳴らさない
  - 設定の変更は localStorage の storage イベントでブラウザソースへ即時に届け、ローカル版はサーバーにも保存する（300ms まとめてから順番に書き込む）
  - 曲の増減は BroadcastChannel の `library-updated` で知らせる

### 2.4 OBS に登録する入口（ローカル版）

OBS に `http://127.0.0.1:<ポート>/…` を直接登録すると、ポートが変わったときに繋がらなくなります。そこで、ポートを含まない入口のページを登録します。

- `local_obs.html`: ブラウザソースに「ローカルファイル」で登録する
- `local_dock.html`: カスタムブラウザドックに `file:///…/local_dock.html` で登録する
- 入口の動き（`local.js`）
  1. 初期設定のポート 8137 の `/api/ping.js` を script 要素で読み込み、Clock Player の印（`window.clockPlayerPing`）を確かめる。ファイルとして開かれたページからは fetch で問い合わせられないため、script 要素を使う
  2. 応答が無ければ、`data/port.js` のポートを同じように確かめる
  3. 見つかったポートの `obs.html` / `index.html?dock` へリダイレクトする（iframe は使わない）
  4. どちらも応答が無ければ、2秒おきに試し続ける。ドックは「start.bat を実行してください」と表示し、ブラウザソースは何も表示しない
- リダイレクトした後のページは入口に戻れないため、OBS を開いたままサーバーを別のポートで再起動した場合は、ソースとドックの再読み込みが必要

---

## 3. ファイル構造

| ファイル | 内容 |
| --- | --- |
| `index.html` | 設定パネル付きのプレイヤー。`?dock` を付けるか OBS 内で開くと、曲名・操作ボタン・設定だけのドック表示になる |
| `obs.html` | ブラウザソース用のプレイヤー（再生役） |
| `index.css` | 画面のデザイン。時間帯の色に合わせたテーマ、ドック表示、OBS 向けの透過・ミニマル表示 |
| `index.js` | 時計、スケジュール、再生、設定パネル、ドックとブラウザソースの同期 |
| `library.js` | 曲と設定の置き場（ローカル版はサーバー、GitHub Pages 版は OPFS と localStorage） |
| `config.js` | 既定のスケジュール |
| `local_obs.html` / `local_dock.html` / `local.js` | ローカル版で OBS に登録する入口 |
| `server.ps1` | ローカルサーバー |
| `start.bat` | サーバーをウィンドウに表示して起動する。ウィンドウを閉じると停止する |
| `start_background.bat` | サーバーをウィンドウを出さずに起動する（`-Background`）。サーバーはウィンドウを持たないプロセス（`CreateNoWindow`）として起動し直し、起動を確かめて登録する場所を表示したら、最初のウィンドウは10秒で閉じる |
| `stop_background.bat` | 起動中のサーバーを止める |
| `README.html` | 取扱説明書（`docs/manual/` のスクリーンショットを使う） |
| `.github/workflows/release.yml` | Release の ZIP を作るワークフロー（6章） |

`index.html` / `obs.html` をサーバーを通さずに開いた場合（`file:` や OBS の `http://absolute/`）は、ローカル版の使い方（起動方法と OBS に登録する場所）を表示する。

---

## 4. API 定義（ローカル版）

`/api/ping.js` 以外は、要求に `X-ClockPlayer: 1` の見出しが必要です。応答は JSON で、失敗したときは `{ "error": "<理由>" }` を返します。

| 要求 | 内容 |
| --- | --- |
| `GET /api/ping.js` | `window.clockPlayerPing = { port: <ポート> };` を返す。入口と二重起動の確認に使う |
| `GET /config.js` | 設定・プリセット・登録場所をまとめた JavaScript を返す（2.3） |
| `GET /api/manifest` | 曲リストを返す |
| `POST /api/rescan` | `bgm` フォルダを走査して曲リストを作り直す。無くなった曲の件数を `{ removed }` で返す |
| `PUT /api/config` | 本文の JSON を `data/config.json` に保存する |
| `PUT /api/presets` | 本文の JSON を `data/presets.json` に保存する |
| `PUT /api/files?folder=&name=&artist=&title=` | 本文を曲として `bgm/<folder>/` に保存し、曲リストに加える。同じ名前があれば `名前 (1).mp3` のようにずらす。曲名が空なら、ファイル名から決める。返り値は曲リスト |
| `DELETE /api/files?folder=&name=` | 曲を削除し、曲リストから外す |
| `DELETE /api/folder?folder=` | フォルダの中身をすべて削除する |
| `DELETE /api/all` | `bgmA`〜`bgmF` の中身をすべて削除する |
| `GET` / `HEAD` そのほか | アプリのファイルと `bgm/` の曲を配信する（Range 対応） |

- `folder` は `bgmA`〜`bgmF` のどれか。それ以外は 400
- 曲として受け付ける拡張子は `mp3` / `wav` / `ogg` / `m4a` / `aac` / `flac`
- 曲の受け取りは本文を少しずつ一時ファイルに書き、終わってから名前を決めて置く（曲全体をメモリに載せない）

---

## 5. UI/UX 仕様

- **24時間スケジュールバー**: 時間帯の境界をドラッグするか、時刻を入力して調整する（入力した時刻は5分単位に丸める）。時間帯は最短30分。追加（選んだ時間帯を2つに分ける）・削除・名前・色・割り当てるフォルダの変更ができる
- **プリセット**: スケジュールを名前を付けて保存・切り替え・削除できる。JSON で書き出し・取り込みもできる
- **曲の登録**: 時間帯を選び、「曲を追加」「フォルダから追加」（サブフォルダも含む）で取り込む。曲ごとの削除、フォルダを空にする、すべて削除、使用量の表示がある。ローカル版は「再読み込み」で `bgm` フォルダを走査し直す。GitHub Pages 版は保存領域の永続化を求め、認められないときは「消える可能性あり」と表示する
- **曲名の読み取り**: 取り込むときに、mp3 は ID3v2.3/2.4 のタグ（先頭の最大 2MB）、m4a は moov 箱（最大 16MB）だけを読む。読めなければファイル名を使う
- **動的テーマ**: 再生中の時間帯の色に合わせて、画面全体の色合いが変わる
- **切り替え**: 時間帯の境界を跨ぐと、今の曲を 1.2 秒かけてフェードアウトし、次の時間帯の曲を 1.0 秒かけてフェードインする。シャッフル再生に対応する
- **OBS 向けの表示**: 背景の透過、ウィンドウ背景を残す、操作ボタンを隠す、時計とプレイヤーの左右入れ替え、ミニマル表示（高さ約 100px）を選べる。ドック自身にはこれらを適用しない
- **OBS に登録する場所**: 設定パネルの曲の登録欄の下に、ブラウザソースとドックに登録する場所をコピーボタン付きで表示する（GitHub Pages 版はブラウザソースの URL だけ）

---

## 6. 配布

- `v` で始まるタグ（例: `v0.2.1`）を push するか、Actions の画面から「Release」をタグ名を入れて実行すると、GitHub Actions が Release を作る
- Release には、ローカル版に必要なファイルだけを `ClockPlayer-<タグ>.zip` にまとめて置く。展開すると `ClockPlayer` フォルダが1つでき、中身は本体・サーバー・起動用の bat・OBS 用の入口・`README.html`・`docs/manual/`・空の `bgm/bgmA`〜`bgmF`
- Release の説明文には、`CHANGELOG.md` の該当する版の項目を使う。項目が無い版では Release を作らずに止まる
- 版の付け方は Semantic Versioning に従う。1.0 までは、互換性のない変更で2桁目を上げる
