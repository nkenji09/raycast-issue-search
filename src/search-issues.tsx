import {
  Action,
  ActionPanel,
  Cache,
  Color,
  Icon,
  Image,
  Keyboard,
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

type ParentIssue = {
  id: string;
  number: number;
  title: string;
  url: string;
  issueType: { name: string } | null;
  parent?: ParentIssue | null;
};

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
  parent: ParentIssue | null;
};

type SearchResult = {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Partial<Issue>[];
  } | null;
};

const PARENT_FIELDS = "id number title url issueType { name }";

/**
 * 親の親より上は、検索とは別に、見つかった親の分だけまとめて取る（useAncestors）。
 * 検索の 300 件すべてに祖先を入れ子で付けると応答が重くなるが、親になる issue は少ないため。
 * GraphQL は同じ形を繰り返し辿れないので入れ子で書き並べる。sub-issue は 8 階層までなので、7 段で一番上まで届く。
 */
const ANCESTOR_FIELDS = Array.from({ length: 7 }).reduce<string>((inner) => `parent { ${PARENT_FIELDS} ${inner} }`, "");

const ISSUE_FIELDS = `id number title url state updatedAt
  repository { nameWithOwner }
  issueType { name }
  assignees(first: 3) { nodes { login avatarUrl } }
  parent { ${PARENT_FIELDS} }`;

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

type Found = { issues: Issue[]; total: number };

/** onPage には、ページが届くたびにそこまでの結果を渡す。全部そろう前に一覧を出せるようにするため。 */
async function searchIssues(
  q: string,
  pages: number,
  first: number,
  signal: AbortSignal,
  onPage?: (found: Found) => void,
): Promise<Found> {
  const issues: Issue[] = [];
  let total = 0;
  let after: string | undefined;
  for (let page = 0; page < pages; page++) {
    const { data, warning } = await ghGraphql<SearchResult>(SEARCH_QUERY, { q, first, after }, signal);
    if (!data.search) throw new Error(warning || "検索に失敗しました");
    total = data.search.issueCount;
    issues.push(...onlyIssues(data.search.nodes));
    onPage?.({ issues: [...issues], total });
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

function readCache<T>(key: string): T | undefined {
  try {
    const raw = cache.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 非同期の取得を、入力が変わるたびに前のものを中止してやり直す。取得中は前の結果を出したままにする。
 * cacheKey を渡すと、前回の結果を次の起動まで覚え、取得を待たずに先に出す。
 * delay を渡すと、入力が止まるまで取得を待つ。打つたびに gh を起動しないため。
 */
function useFetch<T>(
  run: ((signal: AbortSignal, update: (partial: T) => void) => Promise<T>) | null,
  key: string,
  options: { cacheKey?: string; delay?: number } = {},
): { data?: T; isLoading: boolean } {
  const { cacheKey, delay = 0 } = options;
  const [state, setState] = useState<{ data?: T; isLoading: boolean }>(() => ({
    data: cacheKey ? readCache<T>(cacheKey) : undefined,
    isLoading: Boolean(run),
  }));

  useEffect(() => {
    if (!run) {
      setState({ isLoading: false });
      return;
    }
    const controller = new AbortController();
    const cached = cacheKey ? readCache<T>(cacheKey) : undefined;
    setState((prev) => ({ data: cached ?? prev.data, isLoading: true }));
    // 前回の結果を先に出しているときは、途中の結果で件数が減って見えないよう、全部そろうまで差し替えない
    const update = (partial: T) => {
      if (!controller.signal.aborted && cached === undefined) setState({ data: partial, isLoading: true });
    };
    const timer = setTimeout(() => {
      run(controller.signal, update)
        .then((data) => {
          if (controller.signal.aborted) return;
          setState({ data, isLoading: false });
          if (cacheKey) cache.set(cacheKey, JSON.stringify(data));
        })
        .catch((error: Error) => {
          if (controller.signal.aborted) return;
          setState((prev) => ({ data: prev.data, isLoading: false }));
          showToast({ style: Toast.Style.Failure, title: "検索に失敗しました", message: error.message });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
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

type ParentRecord = Omit<ParentIssue, "parent"> & { parentId: string | null };
type ParentMap = Record<string, ParentRecord>;

/**
 * 一覧に出た親について、その上の祖先を一番上まで取り、id ごとの表にする。
 * 表は次の起動まで覚えて先に使い、起動のたびに 1 度だけ取り直して最新にする。
 */
function useAncestors(issues: Issue[]): ParentMap {
  const [map, setMap] = useStored<ParentMap>("parents", {});
  const [fetched] = useState(() => new Set<string>());
  const parentIds = [...new Set(issues.flatMap((issue) => (issue.parent ? [issue.parent.id] : [])))]
    .filter((id) => !fetched.has(id))
    .sort();
  const key = parentIds.join(",");

  useEffect(() => {
    if (parentIds.length === 0) return;
    parentIds.forEach((id) => fetched.add(id));
    type Result = { nodes: (Partial<ParentIssue> | null)[] };
    // nodes(ids:) は 1 回に 100 件まで
    const chunks = Array.from({ length: Math.ceil(parentIds.length / 100) }, (_, i) =>
      parentIds.slice(i * 100, i * 100 + 100),
    );
    Promise.all(
      chunks.map((ids) =>
        // id は GitHub が返した値なので、JSON の文字列としてクエリに埋め込む
        ghGraphql<Result>(
          `{ nodes(ids: ${JSON.stringify(ids)}) { ... on Issue { ${PARENT_FIELDS} ${ANCESTOR_FIELDS} } } }`,
        ),
      ),
    )
      .then((results) => {
        const next: ParentMap = { ...readCache<ParentMap>("parents") };
        const add = (p: ParentIssue) => {
          const { parent, ...rest } = p;
          next[p.id] = { ...rest, parentId: parent?.id ?? null };
          if (parent) add(parent);
        };
        results.forEach(({ data }) => data.nodes.forEach((node) => node?.id && add(node as ParentIssue)));
        setMap(next);
      })
      .catch(() => {
        // 祖先が取れなくても、直接の親は検索の結果にあるので、それだけ出す
        parentIds.forEach((id) => fetched.delete(id));
      });
  }, [key]);

  return map;
}

/** 親を上（Epic 側）から順に並べる。表に無い祖先は、わかっている所までにする。 */
function ancestorsOf(issue: Issue, map: ParentMap): Omit<ParentIssue, "parent">[] {
  const chain: Omit<ParentIssue, "parent">[] = [];
  const seen = new Set<string>();
  let current: Omit<ParentIssue, "parent"> | undefined = issue.parent ?? undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    const parentId: string | null | undefined = map[current.id]?.parentId;
    current = parentId ? map[parentId] : undefined;
  }
  return chain;
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
  const [showDetail, setShowDetail] = useStored<boolean>("detailPanel", false);

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

  const recent = useFetch<Found>(
    baseQuery
      ? (signal, update) => searchIssues(`${baseQuery} sort:updated-desc`, RECENT_PAGES, PAGE_SIZE, signal, update)
      : null,
    baseQuery ?? "",
    { cacheKey: `recent:${baseQuery}` },
  );
  // 本文やコメントにだけ含まれる語も探すため、GitHub の検索も関連の強い順で並べる
  const textSearch = useFetch(
    textQuery ? (signal) => searchIssues(textQuery, 1, TEXT_SEARCH_SIZE, signal) : null,
    textQuery ?? "",
    { delay: 300 },
  );
  const byNumber = useFetch(
    issueNumber !== null && activeRepos.length > 0
      ? (signal) => fetchByNumber(activeRepos, issueNumber, signal)
      : null,
    issueNumber !== null ? `${activeRepos.join(",")}#${issueNumber}` : "",
  );

  // 打つたびに 300 件のタイトルを正規化し直さないよう、取得した時点で 1 度だけ作る
  const normalizedRecent = useMemo(
    () => (recent.data?.issues ?? []).map((issue) => ({ issue, title: normalize(issue.title) })),
    [recent.data],
  );
  const terms = normalize(trimmed).split(/\s+/).filter(Boolean);
  const titleMatches =
    numberMode || hasQualifier
      ? []
      : normalizedRecent.filter(({ title }) => terms.every((term) => title.includes(term))).map(({ issue }) => issue);
  const titleIds = new Set(titleMatches.map((issue) => issue.id));
  const textMatches = textQuery ? (textSearch.data?.issues ?? []).filter((issue) => !titleIds.has(issue.id)) : [];
  const numberMatches = issueNumber !== null ? (byNumber.data ?? []) : [];

  const parentMap = useAncestors([...titleMatches, ...textMatches, ...numberMatches]);

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
      <Action
        title={showDetail ? "詳細パネルを隠す" : "詳細パネルを出す"}
        icon={Icon.Sidebar}
        shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
        onAction={() => setShowDetail(!showDetail)}
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

  const renderItem = (issue: Issue) => {
    const ancestors = ancestorsOf(issue, parentMap);
    const path = ancestors.map((p) => p.title).join(" › ");
    return (
      <List.Item
        key={issue.id}
        icon={
          issue.state === "OPEN"
            ? { source: Icon.Circle, tintColor: Color.Green }
            : { source: Icon.CheckCircle, tintColor: Color.Purple }
        }
        // 行の文字は折り返せず、長いタイトルは切れるので、マウスを載せると全文が出るようにする
        title={{ value: issue.title, tooltip: issue.title }}
        // 詳細パネルを出している間はタイトルの幅が狭いので、親の道筋はパネルに任せて行からは外す
        subtitle={{
          value: `${repos.length > 1 ? issue.repository.nameWithOwner : ""}#${issue.number}${path && !showDetail ? `  ${path}` : ""}`,
          tooltip: path || null,
        }}
        accessories={[
          ...(issue.issueType ? [{ tag: issue.issueType.name }] : []),
          ...issue.assignees.nodes.map((user) => ({
            icon: { source: user.avatarUrl, mask: Image.Mask.Circle },
            tooltip: user.login,
          })),
          { date: new Date(issue.updatedAt), tooltip: "最後に更新された日時" },
        ]}
        detail={
          // 一覧の行の文字はクリックできないので、親へのリンクはこのパネルに置く
          <List.Item.Detail
            // 一覧では切れるタイトルを、パネルでは折り返して全文を読めるようにする
            markdown={`### ${issue.title.replace(/[\\`*_[\]#<>]/g, "\\$&")}`}
            metadata={
              <List.Item.Detail.Metadata>
                {ancestors.map((p) => (
                  <List.Item.Detail.Metadata.Link
                    key={p.url}
                    title={p.issueType?.name ?? "親"}
                    text={`#${p.number} ${p.title}`}
                    target={p.url}
                  />
                ))}
                <List.Item.Detail.Metadata.Link
                  title={`${issue.issueType?.name ?? "この issue"}（これ）`}
                  text={`#${issue.number} ${issue.title}`}
                  target={issue.url}
                />
                <List.Item.Detail.Metadata.Separator />
                <List.Item.Detail.Metadata.Label title="状態" text={issue.state === "OPEN" ? "Open" : "Closed"} />
                <List.Item.Detail.Metadata.Label
                  title="担当者"
                  text={issue.assignees.nodes.map((user) => user.login).join(", ") || "なし"}
                />
                <List.Item.Detail.Metadata.Label title="リポジトリ" text={issue.repository.nameWithOwner} />
                <List.Item.Detail.Metadata.Label
                  title="最後に更新された日時"
                  text={new Date(issue.updatedAt).toLocaleString("ja-JP")}
                />
              </List.Item.Detail.Metadata>
            }
          />
        }
        actions={
          <ActionPanel>
            <ActionPanel.Section>
              <Action.OpenInBrowser url={issue.url} />
              <Action.CopyToClipboard title="URL をコピー" content={issue.url} />
            </ActionPanel.Section>
            {ancestors.length > 0 && (
              // キーボードだけでも親を開けるようにする。番号は subtitle の並び順（一番上の親が 1）
              <ActionPanel.Section title="親の issue">
                {ancestors.map((p, i) => (
                  <Action.OpenInBrowser
                    key={p.url}
                    title={`${p.issueType?.name ?? "親"} を開く：${p.title}`}
                    url={p.url}
                    shortcut={{ modifiers: ["cmd", "shift"], key: String(i + 1) as Keyboard.KeyEquivalent }}
                  />
                ))}
              </ActionPanel.Section>
            )}
            {filterActions}
          </ActionPanel>
        }
      />
    );
  };

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
      isShowingDetail={showDetail}
      searchText={text}
      // 数字だけを打ったら番号で探したいときなので、"#" を補って番号の検索にする
      // 補った "#" を自分で消したときは、消したまま（キーワードの検索）にする
      onSearchTextChange={(value) =>
        setText((prev) => (/^[0-9]+$/.test(value) && prev !== `#${value}` ? `#${value}` : value))
      }
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
