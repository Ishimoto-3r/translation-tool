# 翻訳ツール群

> AI駆動の多目的翻訳・検品・マニュアル作成ツールスイート

## 📋 概要

複数の翻訳・検品・マニュアル作成ツールを統合したWebアプリケーション。OpenAI APIを活用し、実業務に直結する機能を提供します。

### 主な機能

#### 🌐 翻訳ツール
- **基本翻訳** - 日本語↔中国語、任意言語→日本語、英語、韓国語
- **列指定翻訳** - Excel/CSVの特定列を翻訳
- **シート翻訳** - Excelシート全体を翻訳
- **Word翻訳** - Wordファイルを翻訳
- **検証結果翻訳** - 検証レポートを翻訳

#### 🔍 検品ツール
- **検品用マニュアル翻訳** - PDFマニュアルを切り抜いて翻訳
- **検品リスト作成** - PDFから検品項目を自動抽出

#### 📝 マニュアル作成
- **原稿作成（AIチェック）** - マニュアル原稿の校正・作成
- **動画から原稿作成** - 動画を解析して手順書を作成

#### ⭐ その他
- **修理レポート** - 修理報告書の作成支援
- **検証項目作成** - 検証項目リストの作成
- **単発プロンプト** - 自由にAIプロンプトを実行

---

## 🚀 セットアップ

### 必要要件
- Node.js 20.x以上
- OpenAI API Key

### インストール

```bash
# リポジトリをクローン
git clone <repository-url>
cd translation-tool-main

# 依存関係をインストール
npm install
```

### 環境変数設定

Vercelダッシュボードまたは`.env.local`で以下を設定：

```bash
OPENAI_API_KEY=your-api-key-here
MODEL_TRANSLATE=gpt-5.1  # オプション、デフォルト: gpt-5.1
```

---

## 🧪 テスト

### テスト実行

```bash
# 全テスト実行
npm test

# ウォッチモード（開発時に便利）
npm run test:watch

# カバレッジレポート生成
npm run test:coverage
```

### テスト構成

```
__tests__/
├── api/
│   └── translate.test.js      # 翻訳APIのテスト
├── utils/
│   └── text-utils.test.js     # ユーティリティ関数のテスト
└── navigation/
    └── pin-manager.test.js    # ナビゲーション機能のテスト
```

### テスト内容

- ✅ **APIテスト** - 翻訳API（text/sheet/word/verify）の動作確認
- ✅ **ユーティリティテスト** - hasKana関数などの補助関数
- ✅ **ナビゲーションテスト** - ピン留め機能
- ✅ **エラーハンドリング** - パラメータ不足、API Key未設定など

---

## 🏗️ プロジェクト構造

```
translation-tool-main/
├── api/                    # Vercel Serverless Functions
│   ├── translate.js       # 統合翻訳API
│   ├── pdftranslate.js    # PDF翻訳API
│   ├── inspection.js      # 検品リスト作成
│   ├── kensho.js          # 検証項目作成
│   ├── report.js          # 修理レポート
│   └── ...
├── __tests__/             # テストファイル
├── fonts/                 # ローカルフォント（中国語対応）
├── *.html                 # フロントエンドページ
├── *.js                   # フロントエンドロジック
├── navigation.js          # 統一ナビゲーションシステム
├── app.js                 # 共通ユーティリティ
├── package.json           # 依存関係定義
├── jest.config.js         # テスト設定
└── vercel.json            # Vercel設定
```

---

## 🎨 機能詳細

### ナビゲーションシステム

- **アプリランチャー** - Cmd+K / Ctrl+Kで全ツール一覧を表示
- **ピン留め機能** - よく使うツールを上部バーに固定
- **カテゴリ整理** - 翻訳、検品、マニュアル、その他に分類
- **LocalStorage保存** - ユーザー設定を永続化

### 翻訳API仕様

#### テキスト翻訳
```javascript
POST /api/translate?op=text
{
  "systemPrompt": "中国語に翻訳してください",
  "userPrompt": "こんにちは",
  "sourceLang": "日本語",
  "targetLang": "zh"
}
```

#### 行翻訳（Excel/Word/検証）
```javascript
POST /api/translate?op=sheet
{
  "rows": ["こんにちは", "さようなら"],
  "toLang": "中国語",
  "context": "ビジネス文書として翻訳"  // オプション
}
```

---

## 📦 デプロイ（Vercel）

### 前提条件
- GitHub連携済み
- Vercel無料プラン（デプロイ数制限あり）

### デプロイ手順

```bash
# 変更をコミット
git add .
git commit -m "Your commit message"

# GitHubにプッシュ（Vercelが自動デプロイ）
git push origin main
```

### 重要な注意事項

> [!WARNING]
> Vercel無料プランのため、**デプロイ頻度を抑える**必要があります。
> - ローカルで十分にテストしてから本番反映
> - 軽微な修正ごとのデプロイは避ける

### Vercel設定確認事項
1. Environment Variablesに`OPENAI_API_KEY`を設定
2. Function Regionを適切に設定（日本ならTokyo推奨）
3. Node.js Versionが20.xであることを確認

---

## 🔧 開発ガイドライン

### コーディング規約
- フロントエンド: ES6+（モダンJavaScript）
- バックエンド: CommonJS（Vercel互換性）
- コメント: 日本語で記述
- 命名: わかりやすく、日本語コメント必須

### 新機能追加フロー

1. ローカルブランチで開発
2. テストコード作成（`__tests__/`）
3. `npm test`で全テストパス確認
4. ローカルで動作確認
5. コミット→プッシュ→デプロイ

### トラブルシューティング

#### テストが失敗する
```bash
# キャッシュクリア
npm test -- --clearCache

# 依存関係再インストール
rm -rf node_modules package-lock.json
npm install
```

#### Vercelデプロイエラー
- Environment Variablesの確認
- ログを確認（Vercel Dashboard → Deployments → Logs）
- `vercel.json`の設定確認

---

## 📚 参考資料

- [プロジェクトレビュー](./project_review.md) - 包括的な品質評価と改善提案
- [引き継ぎガイド](./handover_guide.md) - 環境移行時の手順
- [実装計画（テスト）](./implementation_plan.md) - テスト基盤構築の詳細

---

## 🤝 貢献

このプロジェクトはAI支援開発で構築されています。改善提案やバグ報告は以下の手順で：

1. Issueを作成して問題を報告
2. フィードバックをAIに共有
3. AIが修正案を提示
4. レビュー→承認→デプロイ

---

## 📄 ライセンス

社内ツールとして開発。外部公開前にライセンス条項を確認してください。

---

## 🙏 謝辞

- OpenAI API - AI翻訳エンジン
- Vercel - ホスティングプラットフォーム
- Jest - テストフレームワーク
- pdf-lib - PDF処理ライブラリ
- ExcelJS - Excel処理ライブラリ

---

**最終更新:** 2026-02-07
**バージョン:** 1.0.0（テスト基盤導入）
