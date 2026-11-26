import {
  Action,
  ActionPanel,
  Cache,
  Color,
  Form,
  Icon,
  Image,
  Keyboard,
  List,
  LocalStorage,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
  useNavigation,
} from "@raycast/api";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { useEffect, useMemo, useState } from "react";

type Prefs = { repos?: string; ghPath?: string };
type IssueState = "open" | "closed" | "all";

/**
 * Iteration の絞り込み。"" は絞り込まない。それ以外の "@" で始まるものは相対の指定で、
 * スプリントが替わっても選び直さずに済むよう、名前ではなくこの形で覚える。ほかは Iteration の名前。
 */
type IterationChoice = string;
const RELATIVE_ITERATIONS = ["@current", "@next", "@previous"] as const;
const NO_ITERATION = "@none";

type Iteration = { title: string; startDate: string; duration: number };
type ProjectInfo = {
  id: string;
  url: string;
  title: string;
  /** Iteration のフィールドが無いプロジェクトでは null */
  iterationField: {
    name: string;
    iterations: Iteration[];
    completedIterations: Iteration[];
  } | null;
  /** Status のフィールドが無いプロジェクトでは null。前のバージョンの記憶には無いので undefined もありうる */
  statusField?: { name: string; options: string[] } | null;
};

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

/** 右上の選択の値で、リポジトリとプロジェクトの id をつなぐ記号。どちらにも現れない文字にする。 */
const SCOPE_SEPARATOR = " ";

const STATE_LABEL: Record<IssueState, string> = {
  open: "Open",
  closed: "Closed",
  all: "Open と Closed",
};

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

/** 1 つ分の書き方を owner/repo にそろえる。形が合わなければ null。 */
function parseRepo(raw: string): string | null {
  const s = raw
    .trim()
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/(\.git)?\/?$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(s) ? s : null;
}

/** 登録の文字列から owner/repo を取り出す。検索クエリに埋め込むので、形が合わないものは捨てる。 */
function parseRepos(raw: string): string[] {
  const repos = raw.split(/[\s,]+/).flatMap((s) => parseRepo(s) ?? []);
  return [...new Set(repos)];
}

/**
 * 登録したリポジトリは LocalStorage に置く。Raycast の設定画面には複数行の入力欄が無く、
 * Cache は容量を超えると消えることがあるため。
 */
const REPOS_KEY = "repos";

/** 読み込み中は undefined。前のバージョンで設定画面に入れていた値は、初めて読むときに引き継ぐ。 */
function useRepos(): [string[] | undefined, (next: string[]) => Promise<void>] {
  // LocalStorage は読むのを待つ必要があるので、同じ値の写しを Cache に置いて最初の表示に使う。
  // 一覧が空のまま画面を出すと、右上の選択が覚えていた値に合わず、先頭に戻されて記憶が消えるため
  const [repos, setRepos] = useState<string[] | undefined>(() => readCache<string[]>(REPOS_KEY));
  const apply = (next: string[]) => {
    cache.set(REPOS_KEY, JSON.stringify(next));
    setRepos(next);
  };
  useEffect(() => {
    LocalStorage.getItem<string>(REPOS_KEY).then((raw) => {
      if (raw !== undefined) return apply(JSON.parse(raw) as string[]);
      const legacy = parseRepos(getPreferenceValues<Prefs>().repos ?? "");
      apply(legacy);
      if (legacy.length > 0) LocalStorage.setItem(REPOS_KEY, JSON.stringify(legacy));
    });
  }, []);
  const save = async (next: string[]) => {
    await LocalStorage.setItem(REPOS_KEY, JSON.stringify(next));
    apply(next);
  };
  return [repos, save];
}

function EditRepos(props: { repos: string[]; onSave: (next: string[]) => Promise<void> }) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string>();

  const submit = async ({ repos }: { repos: string }) => {
    const lines = repos
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const invalid = lines.filter((line) => !parseRepo(line));
    if (invalid.length > 0) {
      setError(`この形では読めません：${invalid.join("、")}`);
      return;
    }
    await props.onSave([...new Set(lines.map((line) => parseRepo(line) as string))]);
    pop();
  };

  return (
    <Form
      navigationTitle="リポジトリを編集する"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="保存する" icon={Icon.Check} onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="repos"
        title="リポジトリ"
        placeholder={"owner/repo\nowner/another-repo"}
        defaultValue={props.repos.join("\n")}
        error={error}
        onChange={() => setError(undefined)}
      />
      <Form.Description
        text={
          "1 行に 1 つ、持ち主とリポジトリの名前を / でつないで書きます（例：octocat/Hello-World）。\n" +
          "GitHub のリポジトリの URL をそのまま貼っても構いません。\n" +
          "書いた順に、検索画面の右上のプルダウンに並びます。"
        }
      />
    </Form>
  );
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

const PROJECT_ITEMS_QUERY = `query($id: ID!, $q: String!, $after: String) {
  node(id: $id) { ... on ProjectV2 {
    items(first: 100, after: $after, query: $q) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { content { ... on Issue { ${ISSUE_FIELDS} } } }
    }
  } }
}`;

/**
 * プロジェクトの絞り込みに当てはまる issue を全件取る。issue の検索には Iteration の条件が無いため。
 * 1 つのイテレーションはふつう数十件なので上限は気にしないが、未設定で絞ると多くなりうるので歯止めだけ置く。
 */
const PROJECT_MAX_PAGES = 10;

async function searchProjectItems(
  projectId: string,
  q: string,
  signal: AbortSignal,
  onPage?: (found: Found) => void,
): Promise<Found> {
  type Result = {
    node: {
      items?: {
        totalCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { content: Partial<Issue> | null }[];
      };
    } | null;
  };
  const issues: Issue[] = [];
  let total = 0;
  let after: string | undefined;
  // 一覧はほかの絞り込みと同じく、最近更新された順に並べる
  const sorted = () => [...issues].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (let page = 0; page < PROJECT_MAX_PAGES; page++) {
    const { data, warning } = await ghGraphql<Result>(PROJECT_ITEMS_QUERY, { id: projectId, q, after }, signal);
    const items = data.node?.items;
    if (!items) throw new Error(warning || "プロジェクトが見つかりません");
    total = items.totalCount;
    issues.push(...onlyIssues(items.nodes.flatMap((node) => (node.content ? [node.content] : []))));
    onPage?.({ issues: sorted(), total });
    if (!items.pageInfo.hasNextPage || !items.pageInfo.endCursor) break;
    after = items.pageInfo.endCursor;
  }
  return { issues: sorted(), total };
}

/** その番号の issue を取る。PR の番号や存在しない番号は結果に出さない。 */
async function fetchByNumber(repo: string, number: number, signal: AbortSignal): Promise<Issue[]> {
  const [owner, name] = repo.split("/");
  type Result = { repository: { issue: Issue | null } | null };
  const { data } = await ghGraphql<Result>(
    `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } }
    }`,
    { owner, name, number },
    signal,
  );
  return data.repository?.issue ? [data.repository.issue] : [];
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
          showToast({
            style: Toast.Style.Failure,
            title: "検索に失敗しました",
            message: error.message,
          });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return state;
}

type RepoMeta = { issueTypes: string[]; projects: ProjectInfo[] };

const REPO_META_FIELDS = `issueTypes(first: 50) { nodes { name } }
  projectsV2(first: 20, query: "is:open") { nodes {
    id title url
    fields(first: 50) { nodes {
      ... on ProjectV2IterationField { name configuration {
        iterations { title startDate duration }
        completedIterations { title startDate duration }
      } }
      ... on ProjectV2SingleSelectField { name options { name } }
    } }
  } }`;

/**
 * 設定したリポジトリごとの、使える Issue Type と、紐づいているプロジェクト。
 * 前回の値を先に使い、起動のたびに 1 度だけ取り直す。見つからないリポジトリがあれば知らせる。
 */
function useRepoMeta(repos: string[]): Record<string, RepoMeta> {
  const [meta, setMeta] = useStored<Record<string, RepoMeta>>("repoMeta", {});
  const key = repos.join(",");

  useEffect(() => {
    if (repos.length === 0) return;
    const fields = repos.map((repo, i) => {
      const [owner, name] = repo.split("/");
      return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${REPO_META_FIELDS} }`;
    });
    type Field = {
      name?: string;
      configuration?: { iterations: Iteration[]; completedIterations: Iteration[] };
      options?: { name: string }[];
    };
    type Result = Record<
      string,
      {
        issueTypes: { nodes: { name: string }[] } | null;
        projectsV2: { nodes: { id: string; title: string; url: string; fields: { nodes: (Field | null)[] } }[] };
      } | null
    >;
    ghGraphql<Result>(`{ ${fields.join("\n")} }`)
      .then(({ data }) => {
        const next: Record<string, RepoMeta> = {};
        repos.forEach((repo, i) => {
          const r = data[`r${i}`];
          if (!r) return;
          next[repo] = {
            issueTypes: (r.issueTypes?.nodes.map((n) => n.name) ?? []).sort(),
            projects: r.projectsV2.nodes.map((p) => {
              const field = p.fields.nodes.find((f) => f?.configuration);
              // Status はプロジェクトを作ると最初からある単一選択のフィールドで、名前で見分ける
              const status = p.fields.nodes.find((f) => f?.options && f.name?.toLowerCase() === "status");
              return {
                id: p.id,
                title: p.title,
                url: p.url,
                iterationField:
                  field?.name && field.configuration ? { name: field.name, ...field.configuration } : null,
                statusField:
                  status?.name && status.options
                    ? { name: status.name, options: status.options.map((o) => o.name) }
                    : null,
              };
            }),
          };
        });
        setMeta(next);
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
        // 検索のほうが同じ原因で失敗して知らせるので、ここでは前回の値を使い続ける
      });
  }, [key]);

  return meta;
}

function addDays(date: string, days: number): Date {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d;
}

function iterationRange(it: Iteration): string {
  const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  return `${md(addDays(it.startDate, 0))}〜${md(addDays(it.startDate, it.duration - 1))}`;
}

/** 選んだ指定が、今日の時点でどの Iteration にあたるか。一覧が無ければ undefined。 */
function resolveIteration(choice: IterationChoice, info: ProjectInfo | null): Iteration | undefined {
  const field = info?.iterationField;
  if (!field) return undefined;
  const now = new Date();
  const all = [...field.completedIterations, ...field.iterations].sort((a, b) =>
    a.startDate.localeCompare(b.startDate),
  );
  const currentIndex = all.findIndex(
    (it) => addDays(it.startDate, 0) <= now && now < addDays(it.startDate, it.duration),
  );
  if (choice === "@current") return all[currentIndex];
  if (choice === "@next") return all.find((it) => addDays(it.startDate, 0) > now);
  if (choice === "@previous") {
    const ended = all.filter((it) => addDays(it.startDate, it.duration) <= now);
    return ended[ended.length - 1];
  }
  return all.find((it) => it.title === choice);
}

const RELATIVE_LABEL: Record<string, string> = {
  "@current": "今のイテレーション",
  "@next": "次のイテレーション",
  "@previous": "前のイテレーション",
};

function iterationLabel(choice: IterationChoice, info: ProjectInfo | null): string {
  if (choice === NO_ITERATION) return "イテレーション未設定";
  const it = resolveIteration(choice, info);
  const range = it ? `（${iterationRange(it)}）` : "";
  return RELATIVE_LABEL[choice] ? `${RELATIVE_LABEL[choice]}${range}` : `イテレーション ${choice}${range}`;
}

/** プロジェクトの絞り込みでは、フィールドの名前がそのまま条件の名前になる。空白を含む名前は引用符で囲む。 */
function fieldQualifierName(fieldName: string): string {
  return /\s/.test(fieldName) ? `"${fieldName}"` : fieldName.toLowerCase();
}

/** プロジェクトの絞り込みの書き方での Iteration の条件。 */
function iterationQualifier(choice: IterationChoice, fieldName: string): string {
  const name = fieldQualifierName(fieldName);
  if (choice === NO_ITERATION) return `no:${name}`;
  if (choice.startsWith("@")) return `${name}:${choice}`;
  return `${name}:"${choice.replace(/"/g, "")}"`;
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

/**
 * 複数を選ぶための一覧の画面。操作のメニュー（ActionPanel）は 1 つ選ぶと必ず閉じるので、
 * Enter で付け外ししても閉じない一覧の画面に分ける。検索画面へは Esc で戻る。
 * 開いた後は呼び出し元の再描画が届かないので、選択はこの画面の中で持ち、変えるたびに onChange で知らせる。
 */
function MultiSelectList(props: {
  name: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [selected, setSelected] = useState(props.selected);
  const update = (next: string[]) => {
    setSelected(next);
    props.onChange(next);
  };
  const summary = selected.length > 0 ? selected.join(" + ") : `すべての ${props.name}`;

  return (
    <List
      navigationTitle={`${props.name} を選ぶ`}
      searchBarPlaceholder={`${props.name} の名前で絞り込む（Enter で付け外し、Esc で戻る）`}
    >
      <List.Section title={`選択中：${summary}`}>
        {props.options.map((option) => {
          const on = selected.includes(option);
          return (
            <List.Item
              key={option}
              title={option}
              icon={on ? { source: Icon.CheckCircle, tintColor: Color.Green } : Icon.Circle}
              actions={
                <ActionPanel>
                  <Action
                    title={on ? "外す" : "選ぶ"}
                    icon={on ? Icon.Circle : Icon.CheckCircle}
                    onAction={() => update(on ? selected.filter((s) => s !== option) : [...selected, option])}
                  />
                  <Action
                    title={`すべての ${props.name}（選択を外す）`}
                    icon={Icon.CheckList}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "backspace" }}
                    onAction={() => update([])}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
    </List>
  );
}

export default function Command() {
  const [loadedRepos, saveRepos] = useRepos();
  const repos = loadedRepos ?? [];
  const meta = useRepoMeta(repos);
  const [text, setText] = useState("");
  // 右上で選ぶ「リポジトリ」か「リポジトリとプロジェクトの組」。プロジェクトを選ぶと Iteration などはそれで動く
  const [scope, setScope] = useStored<string>("scope", "");
  const [scopeRepo, scopeProjectId] = scope.split(SCOPE_SEPARATOR);
  const repo: string | undefined = repos.includes(scopeRepo) ? scopeRepo : repos[0];
  const project = (repo && meta[repo]?.projects.find((p) => p.id === scopeProjectId)) || null;
  // Issue Type はリポジトリごとに、Iteration はプロジェクトごとに種類が違うので、それぞれの単位で覚える
  const [typesByRepo, setTypesByRepo] = useStored<Record<string, string[]>>("issueTypesByRepo", {});
  const [iterationByProject, setIterationByProject] = useStored<Record<string, IterationChoice>>(
    "iterationByProject",
    {},
  );
  const [statusByProject, setStatusByProject] = useStored<Record<string, string[]>>("statusByProject", {});
  const [state, setState] = useStored<IssueState>("state", "open");
  const [mine, setMine] = useStored<boolean>("mine", false);
  const [showDetail, setShowDetail] = useStored<boolean>("detailPanel", false);

  const issueTypes = (repo && typesByRepo[repo]) || [];
  const setIssueTypes = (next: string[]) => repo && setTypesByRepo({ ...typesByRepo, [repo]: next });
  const iteration = (project && iterationByProject[project.id]) || "";
  const setIteration = (next: IterationChoice) =>
    project && setIterationByProject({ ...iterationByProject, [project.id]: next });

  const statuses = (project && statusByProject[project.id]) || [];
  const setStatuses = (next: string[]) => project && setStatusByProject({ ...statusByProject, [project.id]: next });
  const statusOptions = [
    ...statuses.filter((s) => !project?.statusField?.options.includes(s)),
    ...(project?.statusField?.options ?? []),
  ];

  const types = (repo && meta[repo]?.issueTypes) || [];
  // 覚えていた Issue Type が一覧に無いと選べなくなるので、必ず選択肢に含める
  const typeOptions = [...issueTypes.filter((t) => !types.includes(t)), ...types];

  const trimmed = text.trim();
  // "#123" は番号だけで探す。打ちかけの "#" も番号の入力中として扱い、キーワード検索に回さない
  const numberMode = /^#\d*$/.test(trimmed);
  const issueNumber = numberMode && trimmed.length > 1 ? Number(trimmed.slice(1)) : null;
  // "label:bug" のような GitHub の検索条件はタイトルの文字では判定できないので、GitHub の検索だけに任せる
  const hasQualifier = /\S:\S/.test(trimmed);

  const quotedTypes = issueTypes.map((t) => `"${t.replace(/"/g, "")}"`);
  const baseQuery = useMemo(() => {
    if (!repo) return null;
    const parts = [`repo:${repo}`, "is:issue"];
    if (state !== "all") parts.push(`is:${state}`);
    if (quotedTypes.length > 0) parts.push(`(${quotedTypes.map((t) => `type:${t}`).join(" OR ")})`);
    if (mine) parts.push("assignee:@me");
    return parts.join(" ");
  }, [repo, state, quotedTypes.join(","), mine]);

  // プロジェクトの絞り込みの書き方は issue の検索と違い、OR をカンマで書く
  // Iteration も Status も issue の検索では絞れないので、どちらかを選んだらプロジェクトの項目から取る
  const activeIteration = project?.iterationField && iteration ? iteration : "";
  const activeStatuses = project?.statusField ? statuses : [];
  const projectQuery =
    repo && project && (activeIteration || activeStatuses.length > 0)
      ? [
          "is:issue",
          `repo:${repo}`,
          ...(state !== "all" ? [`is:${state}`] : []),
          ...(quotedTypes.length > 0 ? [`type:${quotedTypes.join(",")}`] : []),
          ...(mine ? ["assignee:@me"] : []),
          ...(activeIteration && project.iterationField
            ? [iterationQualifier(activeIteration, project.iterationField.name)]
            : []),
          ...(activeStatuses.length > 0 && project.statusField
            ? [
                `${fieldQualifierName(project.statusField.name)}:${activeStatuses.map((s) => `"${s.replace(/"/g, "")}"`).join(",")}`,
              ]
            : []),
        ].join(" ")
      : null;

  const textQuery = baseQuery && trimmed && !numberMode ? `${baseQuery} ${trimmed}` : null;

  const recent = useFetch<Found>(
    baseQuery && !projectQuery
      ? (signal, update) => searchIssues(`${baseQuery} sort:updated-desc`, RECENT_PAGES, PAGE_SIZE, signal, update)
      : null,
    projectQuery ? "" : (baseQuery ?? ""),
    { cacheKey: `recent:${baseQuery}` },
  );
  const inIteration = useFetch<Found>(
    project && projectQuery ? (signal, update) => searchProjectItems(project.id, projectQuery, signal, update) : null,
    projectQuery ? `${project?.id} ${projectQuery}` : "",
    { cacheKey: `project:${project?.id} ${projectQuery}` },
  );
  // Iteration で絞っている間は、そのイテレーションの issue を全件取ってあるので、それを一覧の元にする
  const listing = projectQuery ? inIteration : recent;
  const iterationIds = useMemo(
    () => (projectQuery ? new Set((inIteration.data?.issues ?? []).map((issue) => issue.id)) : null),
    [projectQuery, inIteration.data],
  );
  // 本文やコメントにだけ含まれる語も探すため、GitHub の検索も関連の強い順で並べる
  const textSearch = useFetch(
    textQuery ? (signal) => searchIssues(textQuery, 1, TEXT_SEARCH_SIZE, signal) : null,
    textQuery ?? "",
    { delay: 300 },
  );
  const byNumber = useFetch(
    issueNumber !== null && repo ? (signal) => fetchByNumber(repo, issueNumber, signal) : null,
    issueNumber !== null ? `${repo}#${issueNumber}` : "",
  );

  // 打つたびに 300 件のタイトルを正規化し直さないよう、取得した時点で 1 度だけ作る
  const normalizedRecent = useMemo(
    () =>
      (listing.data?.issues ?? []).map((issue) => ({
        issue,
        title: normalize(issue.title),
      })),
    [listing.data],
  );
  const terms = normalize(trimmed).split(/\s+/).filter(Boolean);
  const titleMatches =
    numberMode || hasQualifier
      ? []
      : normalizedRecent.filter(({ title }) => terms.every((term) => title.includes(term))).map(({ issue }) => issue);
  const titleIds = new Set(titleMatches.map((issue) => issue.id));
  // GitHub の検索は Iteration で絞れないので、そのイテレーションにある issue だけを残す
  const textMatches = textQuery
    ? (textSearch.data?.issues ?? []).filter(
        (issue) => !titleIds.has(issue.id) && (!iterationIds || iterationIds.has(issue.id)),
      )
    : [];
  const numberMatches = issueNumber !== null ? (byNumber.data ?? []) : [];

  const parentMap = useAncestors([...titleMatches, ...textMatches, ...numberMatches]);

  const isLoading = numberMode ? byNumber.isLoading : listing.isLoading || textSearch.isLoading;

  // 相対の指定を先に、名前で選ぶ Iteration（これからのもの・終わった直近 3 つ）を後に並べる
  const namedIterations = project?.iterationField
    ? [
        ...project.iterationField.iterations,
        ...[...project.iterationField.completedIterations]
          .sort((a, b) => b.startDate.localeCompare(a.startDate))
          .slice(0, 3),
      ].map((it) => it.title)
    : [];
  const iterationChoices: IterationChoice[] = [
    "",
    ...RELATIVE_ITERATIONS,
    NO_ITERATION,
    ...namedIterations,
    // 覚えていた名前が一覧から消えていても、選んでいることが見えるようにする
    ...(iteration && !iteration.startsWith("@") && !namedIterations.includes(iteration) ? [iteration] : []),
  ];

  const editReposAction = (
    <Action.Push
      title="リポジトリを編集する"
      icon={Icon.Pencil}
      shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
      target={<EditRepos repos={repos} onSave={saveRepos} />}
    />
  );

  // 右上の選択はコードから開けないので、どこで選ぶかを知らせる
  const showMissingProjectField = (field: string) =>
    showToast({
      style: Toast.Style.Failure,
      title: project ? `${project.title} には ${field} がありません` : "プロジェクトを選んでいません",
      message: project ? undefined : "右上でリポジトリとプロジェクトの組を選んでください",
    });

  const filterActions = (
    <ActionPanel.Section title="絞り込み">
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
      <Action.Push
        title="Issue Type を選ぶ（複数可）"
        icon={Icon.Tag}
        shortcut={{ modifiers: ["cmd", "shift"], key: "t" }}
        target={
          <MultiSelectList name="Issue Type" options={typeOptions} selected={issueTypes} onChange={setIssueTypes} />
        }
      />
      {project?.iterationField ? (
        <ActionPanel.Submenu
          title="Iteration で絞り込む"
          icon={Icon.Calendar}
          shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
        >
          {iterationChoices.map((choice) => (
            <Action
              key={choice}
              title={choice ? iterationLabel(choice, project) : "Iteration で絞り込まない"}
              icon={iteration === choice ? Icon.CheckCircle : Icon.Circle}
              onAction={() => setIteration(choice)}
            />
          ))}
        </ActionPanel.Submenu>
      ) : (
        <Action
          title="Iteration で絞り込む"
          icon={Icon.Calendar}
          shortcut={{ modifiers: ["cmd", "shift"], key: "i" }}
          onAction={() => showMissingProjectField("Iteration")}
        />
      )}
      {project?.statusField ? (
        <Action.Push
          title="Status で絞り込む（複数可）"
          icon={Icon.CircleProgress}
          shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
          target={<MultiSelectList name="Status" options={statusOptions} selected={statuses} onChange={setStatuses} />}
        />
      ) : (
        <Action
          title="Status で絞り込む"
          icon={Icon.CircleProgress}
          shortcut={{ modifiers: ["cmd", "shift"], key: "p" }}
          onAction={() => showMissingProjectField("Status")}
        />
      )}
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
      {editReposAction}
      <Action title="gh コマンドの場所を設定する" icon={Icon.Gear} onAction={openExtensionPreferences} />
    </ActionPanel.Section>
  );

  const filterSummary = [
    // プロジェクトを選んでいる間、右上にはプロジェクトの名前しか出ないので、リポジトリはここで示す
    ...(project && repo ? [repo.split("/")[1]] : []),
    ...(activeIteration ? [iterationLabel(activeIteration, project)] : []),
    ...(activeStatuses.length > 0 ? [activeStatuses.join(" + ")] : []),
    STATE_LABEL[state],
    ...(issueTypes.length > 0 ? [issueTypes.join(" + ")] : []),
    mine ? "自分が担当" : "担当者を問わない",
  ].join(" ・ ");

  const recentCount = listing.data?.issues.length ?? 0;
  const recentTotal = listing.data?.total ?? 0;
  const recentScope = projectQuery
    ? `${project?.title} で絞った ${recentCount} 件`
    : recentTotal > recentCount
      ? `最近更新された ${recentCount} 件`
      : `${recentCount} 件`;
  const titleSectionTitle = trimmed
    ? `タイトルに含む：${titleMatches.length} 件（${recentScope}の中から）`
    : `${recentTotal > recentCount ? `${recentTotal} 件中 ${recentCount} 件` : `${recentCount} 件`} ・ ${filterSummary}`;

  const renderItem = (issue: Issue) => {
    const ancestors = ancestorsOf(issue, parentMap);
    const path = ancestors.map((p) => p.title).join(" › ");
    // Issue Type が無い親は名前で見分けられないので、何段上の親かで呼ぶ
    const labelOf = (p: (typeof ancestors)[number], i: number) =>
      p.issueType?.name ?? `親（${ancestors.length - i}段上）`;
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
        // 行に親の道筋を並べるとタイトルが切れて読めないので、行には番号だけを出し、親は詳細パネルと番号のツールチップに任せる
        subtitle={{ value: `#${issue.number}`, tooltip: path || null }}
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
                {ancestors.map((p, i) => (
                  <List.Item.Detail.Metadata.Link
                    key={p.url}
                    title={labelOf(p, i)}
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
                    title={`${labelOf(p, i)}を開く：${p.title}`}
                    url={p.url}
                    shortcut={{
                      modifiers: ["cmd", "shift"],
                      key: String(i + 1) as Keyboard.KeyEquivalent,
                    }}
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
  // 開く先は issue の一覧ページにする。検索の条件の書き方が、この拡張機能と同じ ISSUE_ADVANCED のものだから
  const emptyView = (() => {
    if (repos.length === 0) {
      return {
        title: "リポジトリが登録されていません",
        description: "Enter で「リポジトリを編集する」を開き、検索するリポジトリを登録してください",
        actions: <ActionPanel>{editReposAction}</ActionPanel>,
      };
    }
    if (numberMode && issueNumber === null) {
      return {
        title: "issue の番号を入力してください",
        description: filterSummary,
        actions: undefined,
      };
    }
    if (projectQuery && project && issueNumber === null) {
      return {
        title: "該当する issue がありません",
        description: filterSummary,
        actions: (
          <ActionPanel>
            <Action.OpenInBrowser
              title="プロジェクトで同じ条件を開く"
              url={`${project.url}?filterQuery=${encodeURIComponent(`${projectQuery} ${trimmed}`.trim())}`}
            />
            {filterActions}
          </ActionPanel>
        ),
      };
    }
    const webQuery = issueNumber !== null ? `repo:${repo} is:issue ${issueNumber}` : `${baseQuery} ${trimmed}`.trim();
    return {
      title: issueNumber !== null ? `#${issueNumber} の issue は見つかりませんでした` : "該当する issue がありません",
      description: issueNumber !== null ? repo : filterSummary,
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

  // 同じ名前のリポジトリが別の持ち主にもあるときだけ、持ち主まで書く
  const shortName = (r: string) => {
    const name = r.split("/")[1];
    return repos.filter((other) => other.split("/")[1] === name).length > 1 ? r : name;
  };
  // 覚えていたプロジェクトがまだ一覧に無い（取り直す前）ときも、その値を選んだままにする。
  // 選択肢に無い値を渡すと、Dropdown が先頭に戻して記憶を消すため
  const pendingProject = repo === scopeRepo && scopeProjectId && !project ? scope : null;
  const scopeValue = pendingProject ?? (repo ? (project ? `${repo}${SCOPE_SEPARATOR}${project.id}` : repo) : "");

  return (
    <List
      isLoading={isLoading || loadedRepos === undefined}
      isShowingDetail={showDetail}
      searchText={text}
      // 数字だけを打ったら番号で探したいときなので、"#" を補って番号の検索にする
      // 補った "#" を自分で消したときは、消したまま（キーワードの検索）にする
      onSearchTextChange={(value) =>
        setText((prev) => (/^[0-9]+$/.test(value) && prev !== `#${value}` ? `#${value}` : value))
      }
      searchBarPlaceholder="タイトルの一部・本文の語・#番号（label:bug のような条件も書けます）"
      searchBarAccessory={
        loadedRepos === undefined ? undefined : (
          <List.Dropdown tooltip="リポジトリとプロジェクト" value={scopeValue} onChange={setScope}>
            {repos.map((r) => (
              // 選んだ項目の名前の長さで幅が決まり、幅は指定できないので、名前は短くし、どのリポジトリかは区切りの見出しで示す
              <List.Dropdown.Section key={r} title={r}>
                <List.Dropdown.Item title={shortName(r)} value={r} icon={Icon.Folder} keywords={[r]} />
                {(meta[r]?.projects ?? []).map((p) => (
                  <List.Dropdown.Item
                    key={p.id}
                    title={p.title}
                    value={`${r}${SCOPE_SEPARATOR}${p.id}`}
                    icon={Icon.Calendar}
                    keywords={[r]}
                  />
                ))}
                {pendingProject && r === repo && (
                  <List.Dropdown.Item title="プロジェクトを読み込み中" value={pendingProject} icon={Icon.Calendar} />
                )}
              </List.Dropdown.Section>
            ))}
          </List.Dropdown>
        )
      }
      actions={<ActionPanel>{filterActions}</ActionPanel>}
    >
      {!isLoading && loadedRepos !== undefined && <List.EmptyView icon={Icon.MagnifyingGlass} {...emptyView} />}
      {numberMode ? (
        <List.Section
          title={`#${issueNumber ?? ""}（Open / Closed・Issue Type・Iteration・担当者の絞り込みは使いません）`}
        >
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
