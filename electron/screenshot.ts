import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

export async function screenshotPage(url: string, outPath: string, fullPage = false): Promise<{ bytes: number; title: string }> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, offscreen: false },
  })
  try {
    await win.loadURL(url, {
      userAgent: 'Mozilla/5.0 (compatible; one-click-research-agent/0.1) Chrome/120',
    })
    // Give page some time to render JS content
    await new Promise((r) => setTimeout(r, 1500))
    let img
    if (fullPage) {
      try {
        const dims = await win.webContents.executeJavaScript(`
          ({
            w: Math.min(document.documentElement.scrollWidth, 1400),
            h: Math.min(document.documentElement.scrollHeight, 8000),
          })
        `)
        if (dims && dims.w && dims.h) {
          win.setBounds({ width: Math.round(dims.w), height: Math.round(dims.h) })
          await new Promise((r) => setTimeout(r, 800))
        }
      } catch {}
    }
    img = await win.webContents.capturePage()
    const png = img.toPNG()
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, png)
    const title = win.getTitle()
    return { bytes: png.length, title }
  } finally {
    try { win.destroy() } catch {}
  }
}

/** Fetch rendered HTML after JS executes (useful for SPAs). */
export async function fetchRenderedHtml(url: string, timeoutMs = 12000): Promise<{ html: string; finalUrl: string; title: string }> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, offscreen: false, javascript: true },
  })
  try {
    const loadP = win.loadURL(url, {
      userAgent: 'Mozilla/5.0 (compatible; one-click-research-agent/0.1) Chrome/120',
    })
    await Promise.race([
      loadP,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
    await new Promise((r) => setTimeout(r, 1500))
    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML')
    return { html: String(html || ''), finalUrl: win.webContents.getURL(), title: win.getTitle() }
  } finally {
    try { win.destroy() } catch {}
  }
}
