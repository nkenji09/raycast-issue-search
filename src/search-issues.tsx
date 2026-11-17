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

type SearchResult = {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Partial<Issue>[];
  } | null;
};

const ISSUE_FIELDS = `id number title url state updatedAt
  repository { nameWithOwner }
  issueType { name }
  assignees(first: 3) { nodes { login avatarUrl } }`;

const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE_ADVANCED, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${ISSUE_FIELDS} } }
  }
}`;

/**
 * GitHub の検索は単語単位で、単語の途中（"pari" で "parity"）では当たらない。
 * 部分一致させるため、最近の issue をこの件数まで取っておき、タイトルを手元で絞り込む。
 */
const RECENT_PAGES = 3;
const PAGE_SIZE = 100;
const TEXT_SEARCH_SIZE = 30;

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
  variables: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<{ data: T; warning?: string }> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === undefined) continue;
    // -F は数値を数値として渡す。文字列は -f で、型を推測させない
    args.push(typeof value === "number" ? "-F" : "-f", `${name}=${value}`);
  }
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

function onlyIssues(nodes: Partial<Issue>[]): Issue[] {
  return nodes.filter((node): node is Issue => Boolean(node.url));
}

async function searchIssues(q: string, pages: number, first: number, signal: AbortSignal) {
  const issues: Issue[] = [];
  let total = 0;
  let after: string | undefined;
  for (let page = 0; page < pages; page++) {
    const { data, warning } = await ghGraphql<SearchResult>(SEARCH_QUERY, { q, first, after }, signal);
    if (!data.search) throw new Error(warning || "検索に失敗しました");
    total = data.search.issueCount;
    issues.push(...onlyIssues(data.search.nodes));
    if (!data.search.pageInfo.hasNextPage || !data.search.pageInfo.endCursor) break;
    after = data.search.pageInfo.endCursor;
  }
  return { issues, total };
}

/** 各リポジトリから、その番号の issue を取る。PR の番号や存在しない番号は結果に出さない。 */
async function fetchByNumber(repos: string[], number: number, signal: AbortSignal): Promise<Issue[]> {
  const fields = repos.map((repo, i) => {
    const [owner, name] = repo.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { issue(number: ${number}) { ${ISSUE_FIELDS} } }`;
  });
  type Result = Record<string, { issue: Issue | null } | null>;
  const { data } = await ghGraphql<Result>(`{ ${fields.join("\n")} }`, {}, signal);
  return Object.values(data).flatMap((r) => (r?.issue ? [r.issue] : []));
}

/** 非同期の取得を、入力が変わるたびに前のものを中止してやり直す。取得中は前の結果を出したままにする。 */
function useFetch<T>(run: ((signal: AbortSignal) => Promise<T>) | null, key: string): { data?: T; isLoading: boolean } {
  const [state, setState] = useState<{ data?: T; isLoading: boolean }>({ isLoading: Boolean(run) });

  useEffect(() => {
    if (!run) {
      setState({ isLoading: false });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ data: prev.data, isLoading: true }));
    run(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, isLoading: false });
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        setState({ isLoading: false });
        showToast({ style: Toast.Style.Failure, title: "検索に失敗しました", message: error.message });
      });
    return () => controller.abort();
  }, [key]);

  return state;
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

/** 全角と半角、大文字と小文字の違いを無視して比べるための形にする。 */
function normalize(s: string): string {
  return s.normalize("NFKC").toLowerCase();
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
  const trimmed = text.trim();
  // "#123" は番号だけで探す。打ちかけの "#" も番号の入力中として扱い、キーワード検索に回さない
  const numberMode = /^#\d*$/.test(trimmed);
  const issueNumber = numberMode && trimmed.length > 1 ? Number(trimmed.slice(1)) : null;
  // "label:bug" のような GitHub の検索条件はタイトルの文字では判定できないので、GitHub の検索だけに任せる
  const hasQualifier = /\S:\S/.test(trimmed);

  const baseQuery = useMemo(() => {
    if (activeRepos.length === 0) return null;
    const parts = [`(${activeRepos.map((repo) => `repo:${repo}`).join(" OR ")})`, "is:issue"];
    if (state !== "all") parts.push(`is:${state}`);
    if (issueType) parts.push(`type:"${issueType.replace(/"/g, "")}"`);
    if (mine) parts.push("assignee:@me");
    return parts.join(" ");
  }, [activeRepos.join(","), state, issueType, mine]);

  const textQuery = baseQuery && trimmed && !numberMode ? `${baseQuery} ${trimmed}` : null;

  const recent = useFetch(
    baseQuery ? (signal) => searchIssues(`${baseQuery} sort:updated-desc`, RECENT_PAGES, PAGE_SIZE, signal) : null,
    baseQuery ?? "",
  );
  // 本文やコメントにだけ含まれる語も探すため、GitHub の検索も関連の強い順で並べる
  const textSearch = useFetch(
    textQuery ? (signal) => searchIssues(textQuery, 1, TEXT_SEARCH_SIZE, signal) : null,
    textQuery ?? "",
  );
  const byNumber = useFetch(
    issueNumber !== null && activeRepos.length > 0
      ? (signal) => fetchByNumber(activeRepos, issueNumber, signal)
      : null,
    issueNumber !== null ? `${activeRepos.join(",")}#${issueNumber}` : "",
  );

  const terms = normalize(trimmed).split(/\s+/).filter(Boolean);
  const titleMatches =
    numberMode || hasQualifier
      ? []
      : (recent.data?.issues ?? []).filter((issue) => {
          const title = normalize(issue.title);
          return terms.every((term) => title.includes(term));
        });
  const titleIds = new Set(titleMatches.map((issue) => issue.id));
  const textMatches = textQuery ? (textSearch.data?.issues ?? []).filter((issue) => !titleIds.has(issue.id)) : [];
  const numberMatches = issueNumber !== null ? (byNumber.data ?? []) : [];

  const isLoading = numberMode ? byNumber.isLoading : recent.isLoading || textSearch.isLoading;

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

  const filterSummary = [
    STATE_LABEL[state],
    mine ? "自分が担当" : "担当者を問わない",
    activeRepos.length === repos.length ? "すべてのリポジトリ" : activeRepos.join(", "),
  ].join(" ・ ");

  const recentCount = recent.data?.issues.length ?? 0;
  const recentTotal = recent.data?.total ?? 0;
  const recentScope = recentTotal > recentCount ? `最近更新された ${recentCount} 件` : `${recentCount} 件`;
  const titleSectionTitle = trimmed
    ? `タイトルに含む：${titleMatches.length} 件（${recentScope}の中から）`
    : `${recentTotal > recentCount ? `${recentTotal} 件中 ${recentCount} 件` : `${recentCount} 件`} ・ ${filterSummary}`;

  const renderItem = (issue: Issue) => (
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
  );

  // 0 件のときに最初の操作を絞り込みにすると、絞り込みが外れたように見えるので、GitHub での検索を最初に置く。
  // 開く先は issue の一覧ページにする。github.com/search は "(repo:A OR repo:B)" の書き方を受け付けず 0 件になるため
  const emptyView = (() => {
    if (repos.length === 0) {
      return {
        title: "リポジトリが設定されていません",
        description: "設定に owner/repo の形で入力してください",
        actions: <ActionPanel>{filterActions}</ActionPanel>,
      };
    }
    if (activeRepos.length === 0) {
      return {
        title: "リポジトリが 1 つも選ばれていません",
        description: "⌘⇧R で検索するリポジトリを選んでください",
        actions: <ActionPanel>{filterActions}</ActionPanel>,
      };
    }
    if (numberMode && issueNumber === null) {
      return { title: "issue の番号を入力してください", description: filterSummary, actions: undefined };
    }
    const webQuery =
      issueNumber !== null
        ? `(${activeRepos.map((repo) => `repo:${repo}`).join(" OR ")}) is:issue ${issueNumber}`
        : `${baseQuery} ${trimmed}`.trim();
    return {
      title: issueNumber !== null ? `#${issueNumber} の issue は見つかりませんでした` : "該当する issue がありません",
      description: issueNumber !== null ? activeRepos.join(", ") : filterSummary,
      actions: (
        <ActionPanel>
          <Action.OpenInBrowser
            title="GitHub で同じ条件を検索する"
            url={`https://github.com/issues?q=${encodeURIComponent(webQuery)}`}
          />
          {filterActions}
        </ActionPanel>
      ),
    };
  })();

  return (
    <List
      isLoading={isLoading}
      onSearchTextChange={setText}
      searchBarPlaceholder="タイトルの一部・本文の語・#番号（label:bug のような条件も書けます）"
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
      {!isLoading && <List.EmptyView icon={Icon.MagnifyingGlass} {...emptyView} />}
      {numberMode ? (
        <List.Section title={`#${issueNumber ?? ""}（Open / Closed・Issue Type・担当者の絞り込みは使いません）`}>
          {numberMatches.map(renderItem)}
        </List.Section>
      ) : (
        <>
          {!hasQualifier && <List.Section title={titleSectionTitle}>{titleMatches.map(renderItem)}</List.Section>}
          {textQuery && (
            <List.Section title={`GitHub の検索で一致：本文やコメントも含む（${textMatches.length} 件）`}>
              {textMatches.map(renderItem)}
            </List.Section>
          )}
        </>
      )}
    </List>
  );
}
