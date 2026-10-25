import { test as base } from "@playwright/test";
// WebKit's ephemeral sessions cannot persist IDB File/Blob values (upstream
// microsoft/playwright#42795). A fresh persistent profile models normal Safari.
export const test = base.extend({
  context: async (
    {
      context,
      browserName,
      playwright,
      launchOptions,
      baseURL,
      viewport,
      headless,
    },
    use,
  ) => {
    if (browserName !== "webkit") {
      await use(context);
      return;
    }
    const regular = await playwright.webkit.launchPersistentContext("", {
      ...launchOptions,
      baseURL,
      viewport,
      headless,
      acceptDownloads: true,
    });
    try {
      await use(regular);
    } finally {
      await regular.close();
    }
  },
});
