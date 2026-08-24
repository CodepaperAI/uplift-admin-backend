import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, LaunchOptions } from "puppeteer";

puppeteer.use(StealthPlugin());

const DEFAULT_ARGS: string[] = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--disable-gpu",
];

export async function launchStealthBrowser(
  overrides?: Partial<LaunchOptions>
): Promise<Browser> {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  const options: LaunchOptions = {
    headless: true,
    args: DEFAULT_ARGS,
    ...(executablePath ? { executablePath } : {}),
    ...overrides,
  };

  const browser = await puppeteer.launch(options);
  return browser as unknown as Browser;
}
