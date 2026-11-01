# Changelog

このプロジェクトの変更点を記録します。版の付け方は [Semantic Versioning](https://semver.org/lang/ja/) に従い、1.0 までは互換性のない変更で 2 桁目を上げます。

## [Unreleased]

### Added

- GitHub Pages 版を OBS で使えるようにした。設定パネル（`index.html`）を OBS のカスタムブラウザドック、プレイヤー（`obs.html`）をブラウザソースに読み込むと、BroadcastChannel で同期する
  - ドックの再生・一時停止・曲送り・シーク・プレイリストからの選曲がブラウザソースの再生を操作する。ブラウザソースが動いている間、ドック側は音を鳴らさない
  - ドックで変えた設定はブラウザソースに即時反映される
- `library.js`: `bgm_manifest.js` が無い http(s) 配信時に、曲をブラウザの保存領域（Origin Private File System）へ取り込んで再生する
  - 設定パネルに「曲を追加」「フォルダから追加」、曲ごとの削除、フォルダを空にする、すべて削除、使用容量の表示を追加

### Changed

- GitHub Pages 版では設定を `config.js` より localStorage を優先して読むようにした（ローカル版は従来どおり `config.js` を優先）

## [0.1.0]

- 初回公開
