module.exports = async function* screenshot(argv, browser, archiveUrls) {
  let page = await browser.newPage();
  await page._client.send('Emulation.clearDeviceMetricsOverride');
  await page.setViewport({ width: argv.width, height: argv.height });
  await page.setBypassCSP(true);

  yield `Going to ${argv.url} (Viewport: ${argv.width}x${argv.height})`;
  await page.goto(argv.url, { waitUntil: 'networkidle0' });
  if (argv.print) {
    console.info('Using print media for screenshot');
    await page.emulateMediaType('print');
  }

  // Add archive urls footer
  await page.evaluate(({ url, archiveOrgUrl, archiveOrgShortUrl, archiveTodayUrl }) => {
    const date = new Date();

    // Add header
    document.body.innerHTML = `
    <archhive-header style="display:block;background-color: #f7f7f7;border-bottom: 1px solid #b4c2d0;padding: 20px 0;">
      <archhive-header-inner style="display: grid;grid-template-columns: min(15.5%, 300px) 40% repeat(auto-fill, min(19%, 246px));gap: 24px;font-family: arial;font-size: 20px;">
        <img src="https://i.imgur.com/JMJnezT.png" style="height: 58px;margin-left: 10%;">
        <archhive-header-item style="display:flex;flex-direction: column;">
          <span style="display:block;">
            <span style="color: grey;font-variant: common-ligatures;font-weight: 700;letter-spacing: 0.04em;">URL</span>
            ${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
      2,
      '0'
    )}-${String(date.getUTCDate()).padStart(2, '0')}
          </div>
          <span style="display:block;text-decoration: underline;color: -webkit-link;">
            ${removeProtocol(url)}
          </span>
        </archhive-header-item>
        <archhive-header-item style="display:flex;flex-direction: column;">
          <span style="display:block;color: grey;font-variant: common-ligatures;font-weight: 700;letter-spacing: 0.04em;">ARCHIVE.ORG</div>
          <span style="display:block;text-decoration: underline;color: -webkit-link;font-family:monospace">
            ${removeProtocol(archiveOrgShortUrl)}
          </span>
        </archhive-header-item>
        <archhive-header-item style="display:flex;flex-direction: column;">
          <span style="display:block;color: grey;font-variant: common-ligatures;font-weight: 700;letter-spacing: 0.04em;">ARCHIVE.TODAY</div>
          <span style="display:block;text-decoration: underline;color: -webkit-link;font-family:monospace">
            ${removeProtocol(archiveTodayUrl)}
          </span>
        </archhive-header-item>
      </archhive-header-inner>
    </archhive-header>
    
    <archhive-content style="position:relative">${
      document.body.innerHTML
    }</archhive-content>`;
    function removeProtocol(url) {
      return url.replace(/^https?:\/\//, '');
    }

    // position:fixed -> position:absolute
    // Needed for sites such as NYTimes
    const elems = Array.from(document.body.getElementsByTagName('*'));
    for (const elem of elems) {
      if (window.getComputedStyle(elem, null).getPropertyValue('position') === 'fixed') {
        elem.style.position = 'absolute';
      }
    }
  }, archiveUrls);

  try {
    // Load all lazy loading images
    await page.evaluate(`(async () => {
    document.body.scrollIntoView(false);
    await Promise.all(
      Array.from(document.querySelectorAll('img')).map((img) => {
        if (img.complete) return;
        return new Promise((resolve, reject) => {
          img.addEventListener('load', resolve);
          img.addEventListener('error', reject);
        });
      })
    );
  })()`);
  } catch (e) {}

  yield 'Taking full-page screenshot';
  const image = await page.screenshot({
    path: argv.output,
    fullPage: true,
    quality: argv.quality,
  });
  await page.close();
  await browser.close();
  yield image;
};
