/* global process, console, URL */
// Captura as telas do dashboard para os manuais (docs/images). Uso:
//   node scripts/capture-dashboard-screenshots.mjs <url-com-token> [pasta-de-saida]
// Precisa de Chrome (SSDD_BROWSER_CHANNEL troca o canal, ex.: msedge). Não altera dados: só abre abas e diálogos.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [url, outDir = "docs/images"] = process.argv.slice(2);
if (!url) { console.error("Informe a URL do dashboard com token."); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: process.env.SSDD_BROWSER_CHANNEL ?? "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
const shot = async (name, fullPage = true) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage });
  console.log("ok", name);
};
// Tela de login: contexto sem sessão.
const anonymous = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "pt-BR" });
await anonymous.goto(new URL(url).origin + "/", { waitUntil: "networkidle" });
await anonymous.screenshot({ path: join(outDir, "tela-login.png") });
console.log("ok tela-login");
await anonymous.close();
await page.goto(url, { waitUntil: "networkidle" });
const tabs = ["home", "metrics", "roadmap", "history", "specifications", "backlog", "board", "quality", "activity", "retrospective"];
for (const tab of tabs) {
  await page.click(`#${tab}-tab`);
  await shot(`tela-${tab}`);
}
// Diálogos: abrir, capturar o viewport e fechar com Esc.
const snapDialog = async (name, open) => {
  await open();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, `dialogo-${name}.png`) });
  console.log("ok dialogo", name);
  await page.keyboard.press("Escape");
};
await page.click("#backlog-tab");
await snapDialog("novo-pbi", () => page.click("#create-work-item"));
await snapDialog("detalhe-item", () => page.locator("#backlog-view [data-open-item], #backlog-view .row-open").first().click());
await page.click("#board-tab");
await snapDialog("mover-item", () => page.locator(".board-column .card-actions button, .board-column button").filter({ hasText: "Mover item" }).first().click());
await page.click("#quality-tab");
await snapDialog("novo-cenario", () => page.click("#create-scenario"));
await page.click("#specifications-tab");
await snapDialog("nova-especificacao", () => page.click("#create-specification, #new-specification"));
await snapDialog("planejamento", () => page.click("#open-planning"));
await browser.close();
