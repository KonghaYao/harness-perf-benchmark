/**
 * 压测剧本用的 markdown 正文生成 —— 长剧本生成器（gen-long-run）每轮的正文从这里来，
 * 「有代表性的 markdown」只此一份，免得改一处漏一处。
 *
 * 内容覆盖标题 / 中英混排段落 / 无序与有序列表 / 代码块 / 表格 / 引用 / 强调 / 链接，
 * 以及全角标点与 emoji 这类高位字符：目标是让 harness 的流式解析与 markdown 渲染
 * 都走在真实路径上，而不是拿重复字符糊体积。
 */

/** 一段有代表性的 markdown（约 900 字节）。seed 决定编号，便于一眼看出渲染到第几段。 */
function markdownBlock(seed: number): string {
    return [
        `## 片段 ${seed} — Perf Block`,
        "",
        `这一段用于压测渲染与流式解析：中文与 English words 混排，内含 \`inline code\`、`,
        `数字 ${seed * 1234567}、以及全角标点（，。！）与 emoji 🚀 之类的高位字符。`,
        "重复的段落文本用来把单条响应撑到目标体积，模拟真实长报告的输出形态。",
        "",
        "- 列表项 A：覆盖无序列表的行内样式与缩进计算；",
        "- 列表项 B：覆盖 `code`、**粗体**、*斜体* 混排；",
        "- 列表项 C：覆盖较长的一行文本，用来触发折行与宽度计算，让渲染路径有稳定负载。",
        "",
        "1. 有序项一：编号渲染；",
        "2. 有序项二：与无序列表交替出现；",
        "",
        "> 引用块：把一段说明放进 blockquote，检查前缀符号与折行缩进的处理。",
        "",
        "```ts",
        `// 片段 ${seed}：代码块要高亮、要折行，也要参与流式解析`,
        `export function tick${seed}(i: number): number {`,
        "    return i * 2;",
        "}",
        "```",
        "",
        "| 指标 | 数值 | 说明 |",
        "| --- | ---: | --- |",
        `| tick | ${seed} | 采样序号 |`,
        `| cpu | ${(seed * 7) % 100}% | 单核口径 |`,
        `| rss | ${(seed * 13) % 512}MB | 常驻内存 |`,
        "",
        "[链接](https://example.com/perf) 与 **粗体**、*斜体*、~~删除线~~ 收尾。",
        "",
    ].join("\n");
}

/**
 * 生成不少于 targetBytes（UTF-8 字节）的 markdown：`heading` 打头，其后按需追加 markdownBlock。
 * seed 给各条响应一个编号区间，避免所有条目的段落编号都从 1 开始、看起来像同一份内容。
 */
export function largeMarkdown(heading: string, targetBytes: number, seed: number): string {
    const parts: string[] = [heading, ""];
    let bytes = Buffer.byteLength(heading, "utf8");
    let n = 0;
    while (bytes < targetBytes) {
        n += 1;
        const piece = markdownBlock(seed + n);
        parts.push(piece);
        bytes += Buffer.byteLength(piece, "utf8");
    }
    return parts.join("\n");
}
