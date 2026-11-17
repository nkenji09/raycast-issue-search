# Raycast Issue Search

GitHub の issue を Raycast から検索し、選んだものをブラウザで開く Raycast 拡張機能です。

認証には、手元の `gh` コマンドのログインをそのまま使います。
Raycast に GitHub へのアクセスを新しく許可する必要がなく、この拡張機能がトークンを保存することもありません。
組織が外部アプリの許可に管理者の承認を求めていても、`gh` で見えるリポジトリならそのまま検索できます。

## 必要なもの

- macOS と [Raycast](https://www.raycast.com/)
- [GitHub CLI](https://cli.github.com/)（`gh auth login` でログイン済みであること）
- Node.js 22.22.2 以上

## 入れ方

Raycast のストアには出していないので、手元でビルドして登録します。

```sh
git clone https://github.com/nkenji09/raycast-issue-search.git
cd raycast-issue-search
npm install
npm run dev
```

Raycast に「Issue を検索」が現れたら、`npm run dev` は Ctrl+C で止めて構いません。登録はそのまま残ります。

初めて開くと設定画面が出るので、「リポジトリ」に検索したいリポジトリを `owner/repo` の形でカンマ区切りで入れてください。
`gh` が Homebrew の標準の場所（`/opt/homebrew/bin` か `/usr/local/bin`）に無い場合は、「gh コマンドの場所」も入れてください。

## 使い方

| 操作 | キー |
|---|---|
| ブラウザで開く | Enter |
| URL をコピー | ⌘ Enter |
| 検索するリポジトリを選ぶ | ⌘ ⇧ R |
| Open / Closed を切り替える | ⌘ ⇧ S |
| 自分が担当のものだけにする | ⌘ ⇧ M |
| Issue Type で絞り込む | 検索欄の右のプルダウン |

絞り込みの状態は、次に開いたときも引き継がれます。
検索欄には `label:bug` のような GitHub の検索条件もそのまま書けます。

## できないこと

- GitHub Enterprise Server には対応していません（github.com のみ）。
- 対象は issue だけで、PR は出ません。
- 一度に表示するのは、更新が新しい順に 50 件までです。
- Issue Type は組織のリポジトリにしか無いため、個人のリポジトリだけを設定するとプルダウンは「すべての Issue Type」のみになります。
- 画面の文言は日本語のみです。

## License

MIT
