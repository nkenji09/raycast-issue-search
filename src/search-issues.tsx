import {
  Action,
  ActionPanel,
  Cache,
  Color,
  Icon,
  Image,
  List,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { useEffect, useMemo, useState } from "react";

type Prefs = { repos: string; ghPath?: string };
type IssueState = "open" | "closed" | "all";

type Issue = {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  updatedAt: string;
  repository: { nameWithOwner: string };
  issueType: { name: string } | null;
  assignees: { nodes: { login: string; avatarUrl: string }[] };
};

const SEARCH_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE_ADVANCED, first: 50) {
    issueCount
    nodes {
      ... on Issue {
        id number title url state updatedAt
        repository { nameWithOwner }
        issueType { name }
        assignees(first: 3) { nodes { login avatarUrl } }
      }
    }
  }
}`;

const STATE_LABEL: Record<IssueState, string> = { open: "Open", closed: "Closed", all: "Open と Closed" };

const cache = new Cache();

/** 絞り込みを次回の起動まで覚えておくための useState。 */
function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = cache.get(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  return [
    value,
    (next) => {
      cache.set(key, JSON.stringify(next));
      setValue(next);
    },
  ];
}

/** 設定の文字列から owner/repo を取り出す。検索クエリに埋め込むので、形が合わないものは捨てる。 */
function parseRepos(raw: string): string[] {
  const repos = raw
    .split(/[\s,]+/)
    .map((s) => s.replace(/^https?:\/\/github\.com\//, "").replace(/(\.git)?\/?$/, ""))
    .filter((s) => /^[\w.-]+\/[\w.-]+$/.test(s));
  return [...new Set(repos)];
}

function resolveGh(ghPath?: string): string {
  if (ghPath?.trim()) return ghPath.trim();
  // Raycast から起動したプロセスの PATH には Homebrew が入らないので、標準の場所を直接見る
  return ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].find((p) => existsSync(p)) ?? "gh";
}

/** gh のログインで GraphQL を呼ぶ。一部だけ失敗した応答は、取れた分と失敗の文を両方返す。 */
function ghGraphql<T>(
  query: string,
  variables: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<{ data: T; warning?: string }> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) args.push("-f", `${name}=${value}`);
  const { ghPath } = getPreferenceValues<Prefs>();

  return new Promise((resolve, reject) => {
    execFile(resolveGh(ghPath), args, { signal, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      let data: T | undefined;
      try {
        data = JSON.parse(stdout).data ?? undefined;
      } catch {
        // 下で error として扱う
      }
      if (data) return resolve({ data, warning: error ? stderr.trim() : undefined });
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
        return reject(new Error("gh コマンドが見つかりません。拡張機能の設定で場所を指定してください。"));
      }
      reject(new Error(stderr.trim() || error?.message || "gh の応答を読めませんでした"));
    });
  });
}

/** 設定したリポジトリで使える Issue Type の名前。見つからないリポジトリがあれば知らせる。 */
function useIssueTypes(repos: string[]): string[] {
  const [types, setTypes] = useStored<string[]>("issueTypes", []);
  const key = repos.join(",");

  useEffect(() => {
    if (repos.length === 0) return;
    const fields = repos.map((repo, i) => {
      const [owner, name] = repo.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issueTypes(first: 50) { nodes { name } } }`;
    });
    type Result = Record<string, { issueTypes: { nodes: { name: string }[] } | null } | null>;
    ghGraphql<Result>(`{ ${fields.join("\n")} }`)
      .then(({ data }) => {
        const names = Object.values(data).flatMap((r) => r?.issueTypes?.nodes.map((n) => n.name) ?? []);
        setTypes([...new Set(names)].sort());
        const missing = repos.filter((_, i) => !data[`r${i}`]);
        if (missing.length > 0) {
          showToast({
            style: Toast.Style.Failure,
            title: "見つからないリポジトリがあります",
            message: missing.join(", "),
          });
        }
      })
      .catch(() => {
        // 検索のほうが同じ原因で失敗して知らせるので、ここでは前回の一覧を使い続ける
      });
  }, [key]);

  return types;
}

export default function Command() {
  const repos = useMemo(() => parseRepos(getPreferenceValues<Prefs>().repos), []);
  const [text, setText] = useState("");
  const [excluded, setExcluded] = useStored<string[]>("excludedRepos", []);
  const [issueType, setIssueType] = useStored<string>("issueType", "");
  const [state, setState] = useStored<IssueState>("state", "open");
  const [mine, setMine] = useStored<boolean>("mine", false);

  const types = useIssueTypes(repos);
  // 覚えていた Issue Type が一覧に無いと Dropdown が先頭に戻して記憶を消すので、必ず選択肢に含める
  const typeOptions = issueType && !types.includes(issueType) ? [issueType, ...types] : types;

  const activeRepos = repos.filter((repo) => !excluded.includes(repo));
  const query = useMemo(() => {
    if (activeRepos.length === 0) return null;
    const parts = [`(${activeRepos.map((repo) => `repo:${repo}`).join(" OR ")})`, "is:issue"];
    if (state !== "all") parts.push(`is:${state}`);
    if (issueType) parts.push(`type:"${issueType.replace(/"/g, "")}"`);
    if (mine) parts.push("assignee:@me");
    if (text.trim()) parts.push(text.trim());
    parts.push("sort:updated-desc");
    return parts.join(" ");
  }, [activeRepos.join(","), state, issueType, mine, text]);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!query) {
      setIssues([]);
      setTotal(0);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsLoading(true);
    type Result = { search: { issueCount: number; nodes: Partial<Issue>[] } | null };
    ghGraphql<Result>(SEARCH_QUERY, { q: query }, controller.signal)
      .then(({ data, warning }) => {
        if (!data.search) throw new Error(warning || "検索に失敗しました");
        setIssues(data.search.nodes.filter((node): node is Issue => Boolean(node.url)));
        setTotal(data.search.issueCount);
        setIsLoading(false);
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setIsLoading(false);
        showToast({ style: Toast.Style.Failure, title: "検索に失敗しました", message: error.message });
      });
    return () => controller.abort();
  }, [query]);

  const toggleRepo = (repo: string) =>
    setExcluded(excluded.includes(repo) ? excluded.filter((r) => r !== repo) : [...excluded, repo]);

  const filterActions = (
    <ActionPanel.Section title="絞り込み">
      <ActionPanel.Submenu
        title="リポジトリを選ぶ"
        icon={Icon.Filter}
        shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
      >
        {repos.map((repo) => (
          <Action
            key={repo}
            title={repo}
            icon={excluded.includes(repo) ? Icon.Circle : Icon.CheckCircle}
            onAction={() => toggleRepo(repo)}
          />
        ))}
        <Action title="すべて選ぶ" icon={Icon.CheckList} onAction={() => setExcluded([])} />
      </ActionPanel.Submenu>
      <ActionPanel.Submenu
        title="Open / Closed を切り替える"
        icon={Icon.Switch}
        shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
      >
        {(Object.keys(STATE_LABEL) as IssueState[]).map((value) => (
          <Action
            key={value}
            title={STATE_LABEL[value]}
            icon={state === value ? Icon.CheckCircle : Icon.Circle}
            onAction={() => setState(value)}
          />
        ))}
      </ActionPanel.Submenu>
      <Action
        title={mine ? "担当者で絞り込まない" : "自分が担当のものだけにする"}
        icon={Icon.Person}
        shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
        onAction={() => setMine(!mine)}
      />
      <Action title="リポジトリの設定を開く" icon={Icon.Gear} onAction={openExtensionPreferences} />
    </ActionPanel.Section>
  );

  const summary = [
    total > issues.length ? `${total} 件中 ${issues.length} 件` : `${issues.length} 件`,
    STATE_LABEL[state],
    mine ? "自分が担当" : "担当者を問わない",
    activeRepos.length === repos.length ? "すべてのリポジトリ" : activeRepos.join(", "),
  ].join(" ・ ");

  return (
    <List
      isLoading={isLoading}
      throttle
      onSearchTextChange={setText}
      searchBarPlaceholder="キーワードで検索（label:bug のような条件も書けます）"
      searchBarAccessory={
        <List.Dropdown tooltip="Issue Type" value={issueType} onChange={setIssueType}>
          <List.Dropdown.Item title="すべての Issue Type" value="" />
          {typeOptions.map((name) => (
            <List.Dropdown.Item key={name} title={name} value={name} />
          ))}
        </List.Dropdown>
      }
      actions={<ActionPanel>{filterActions}</ActionPanel>}
    >
      <List.EmptyView
        icon={Icon.MagnifyingGlass}
        title={
          repos.length === 0
            ? "リポジトリが設定されていません"
            : activeRepos.length === 0
              ? "リポジトリが 1 つも選ばれていません"
              : "該当する issue がありません"
        }
        description={repos.length === 0 ? "設定に owner/repo の形で入力してください" : summary}
        actions={<ActionPanel>{filterActions}</ActionPanel>}
      />
      <List.Section title={summary}>
        {issues.map((issue) => (
          <List.Item
            key={issue.id}
            icon={
              issue.state === "OPEN"
                ? { source: Icon.Circle, tintColor: Color.Green }
                : { source: Icon.CheckCircle, tintColor: Color.Purple }
            }
            title={issue.title}
            subtitle={`${repos.length > 1 ? issue.repository.nameWithOwner : ""}#${issue.number}`}
            accessories={[
              ...(issue.issueType ? [{ tag: issue.issueType.name }] : []),
              ...issue.assignees.nodes.map((user) => ({
                icon: { source: user.avatarUrl, mask: Image.Mask.Circle },
                tooltip: user.login,
              })),
              { date: new Date(issue.updatedAt), tooltip: "最後に更新された日時" },
            ]}
            actions={
              <ActionPanel>
                <ActionPanel.Section>
                  <Action.OpenInBrowser url={issue.url} />
                  <Action.CopyToClipboard title="URL をコピー" content={issue.url} />
                </ActionPanel.Section>
                {filterActions}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
