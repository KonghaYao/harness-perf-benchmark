/**
 * harness 身份：写入端（run.ts 决定产物落哪个目录）与读取端（gen-chart-data / 迁移脚本）
 * **共用同一份别名表**——两边各写一份的话，「命令名 ≠ 目录名」的 harness（如 `claude`）
 * 会在图里裂成两条线（实测踩过：二进制名没登记别名时，图例就落成裸命令名）。
 *
 * 解析顺序（谁先有值用谁）：
 *   1. 显式 `--harness <id>`；
 *   2. 各 playground 的 perf-demo.ts 自己带的默认值（写进 config.harnessId）；
 *   3. 启动命令第一个 token 的文件名 → 查别名表；
 *   4. 兜底 `unknown`（宁可显眼地错，也不要静默落进别人的目录）。
 */

/** harness 目录名：小写 ascii + `-`，不用中文与空格（它要进路径）。 */
const HARNESS_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 命令名 → harness id。只在「命令名与目录名不同」时才需要登记：
 * - Claude Code 的二进制叫 `claude`，目录名沿用仓库里的 playground 名 `claude-code`；
 * - MiniMax Code CLI 的二进制叫 `mcode`，目录名是 `minimax-code`；
 * - Antigravity CLI 的二进制叫 `agy`，目录名是 `antigravity`；
 * - ccode 的默认构建产物叫 `ccode-cli`，harness id 是 `ccode`。
 */
export const HARNESS_ALIASES: Readonly<Record<string, string>> = {
    claude: "claude-code",
    mcode: "minimax-code",
    agy: "antigravity",
    "ccode-cli": "ccode",
};

/** 图例/表格里的展示名（只影响观感，进不了路径）。 */
export const DISPLAY_NAMES: Readonly<Record<string, string>> = {
    peri: "peri",
    opencode: "opencode",
    opencode2: "opencode2",
    "claude-code": "Claude Code",
    codex: "Codex",
    pi: "pi",
    copilot: "GitHub Copilot CLI",
    dsh: "dsh",
    "minimax-code": "MiniMax Code",
    antigravity: "Antigravity CLI",
    hermes: "Hermes Agent",
    cline: "Cline",
    zcode: "ZCode",
    kimi: "Kimi Code",
    "qwen-code": "Qwen Code",
    ccode: "ccode",
};

/** 展示名：认识的给规范写法，不认识的原样用 id。 */
export function displayName(harnessId: string): string {
    return DISPLAY_NAMES[harnessId] ?? harnessId;
}

/** 显式传入的 harness id 是否合法（要当目录名用）。 */
export function isValidHarnessId(raw: string): boolean {
    return HARNESS_ID_PATTERN.test(raw);
}

/** 把任意字符串归一成可用的 harness id（取不到合法字符时返回 "unknown"）。 */
export function normalizeHarnessId(raw: string): string {
    const cleaned = raw
        .trim()
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");
    return cleaned === "" || !HARNESS_ID_PATTERN.test(cleaned) ? "unknown" : cleaned;
}

/** 命令名（含路径）→ harness id：取文件名，查别名表，再归一。 */
export function harnessIdOfBinary(binary: string): string {
    const name = binary.split("/").pop() ?? "";
    return HARNESS_ALIASES[name] ?? normalizeHarnessId(name);
}

/**
 * 从命令**行**（`quote()` 之后的字符串，人读日志里那种）取 harness id。
 * 只有解析老布局的产物时才需要——新产物直接读 run.json 的 harness.id。
 */
export function harnessIdFromCommandLine(commandLine: string): string {
    const first = commandLine.trim().split(/\s+/)[0] ?? "";
    const unquoted =
        first.startsWith("'") && first.endsWith("'") && first.length > 1
            ? first.slice(1, -1).replaceAll("'\\''", "'")
            : first;
    return harnessIdOfBinary(unquoted);
}

/** 从命令数组（run.ts 里 `harnessCommand(config)` 的返回值）取 harness id。 */
export function harnessIdFromCommand(command: readonly string[]): string {
    return harnessIdOfBinary(command[0] ?? "");
}
