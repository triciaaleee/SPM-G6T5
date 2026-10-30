import { describe, expect, it } from "vitest";

/**
 * Guards the audit fixes in frontend/docs/frontend-audit.md (A1, A2, B3, B4, B9): the scoped CSS in every
 * component may only use colours from the tokens, weights and sizes from Style.md, and a font size always
 * comes with its line height (Style.md sections 2, 4.2, 4.3, 5).
 */
const SOURCES = import.meta.glob<string>("../**/*.vue", { query: "?raw", import: "default", eager: true });

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every `selector { body }` in each file's <style> blocks, comments removed. */
function rules(): Rule[] {
  return Object.entries(SOURCES)
    .filter(([path]) => !path.includes("/__tests__/"))
    .flatMap(([path, text]) =>
      [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].flatMap((block) => {
        const css = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
        return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
          file: path.replace("../", ""),
          selector: m[1].trim().replace(/\s+/g, " "),
          body: m[2],
        }));
      }),
    );
}

const ALL_RULES = rules();
const where = (r: Rule) => `${r.file}  ${r.selector}`;

// Section 4.2 sizes, in rem (px / 16).
const SIZE_SCALE = new Set([0.5, 0.625, 0.6875, 0.75, 0.875, 1, 1.125, 1.25, 1.5, 1.75, 2, 2.25, 3]);
// Section 4.3 weights, and the ones index.html loads: 400, 700, 900 (Google Fonts serves no Lato 600).
const WEIGHTS = new Set(["400", "700", "900"]);

describe("style guard (Style.md)", () => {
  it("finds the component styles it is guarding", () => {
    expect(ALL_RULES.length).toBeGreaterThan(500);
  });

  it("uses no hex colours in component CSS (colours come from tokens)", () => {
    const bad = ALL_RULES.filter((r) => /#[0-9a-fA-F]{3,8}\b/.test(r.body)).map(where);
    expect(bad).toEqual([]);
  });

  it("uses only the font weights Style.md defines", () => {
    const bad = ALL_RULES.filter((r) =>
      [...r.body.matchAll(/font-weight\s*:\s*([^;]+);/g)].some((m) => !WEIGHTS.has(m[1].trim())),
    ).map(where);
    expect(bad).toEqual([]);
  });

  it("uses only font sizes from the Section 4.2 scale", () => {
    const bad = ALL_RULES.filter((r) =>
      [...r.body.matchAll(/(?<![-\w])font-size\s*:\s*([0-9.]+)(rem|px)\s*;/g)].some((m) => {
        const rem = Number(m[1]) / (m[2] === "px" ? 16 : 1);
        return !SIZE_SCALE.has(rem);
      }),
    ).map(where);
    expect(bad).toEqual([]);
  });

  it("gives every font size its line height in the same rule", () => {
    const bad = ALL_RULES.filter(
      (r) => /(?<![-\w])font-size\s*:\s*[0-9.]+(rem|px)\s*;/.test(r.body) && !/line-height\s*:/.test(r.body),
    ).map(where);
    expect(bad).toEqual([]);
  });

  it("draws circles with radius-full, not a percentage", () => {
    const bad = ALL_RULES.filter((r) => /border-radius\s*:\s*50%/.test(r.body)).map(where);
    expect(bad).toEqual([]);
  });

  it("defines the status tone colours only once, in style.css", () => {
    const bad = ALL_RULES.filter((r) =>
      r.selector.split(",").some((s) => /^\.status-(success|warning|attention|error|info|open|neutral|over)$/.test(s.trim())),
    ).map(where);
    expect(bad).toEqual([]);
  });

  it("does not use Grey/500 for text (it is 4.3:1 on white; muted text is Grey/600)", () => {
    const bad = ALL_RULES.filter((r) => /(?<![-\w])color\s*:\s*var\(--color-grey-500\)/.test(r.body)).map(where);
    expect(bad).toEqual([]);
  });

});
