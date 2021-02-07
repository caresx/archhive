#!/usr/bin/env node
import { join } from 'path';
import yargs from 'yargs';
import ora from 'ora';
import open from 'open';
import { appendFileSync } from 'fs';
import enquirer from 'enquirer';
import screenshot from './src/screenshot.js';
import archiveMethods from './src/archive.js';
import resolveStylesheet from './src/stylesheet.js';
import addExifMetadata from './src/exif.js';
import launchBrowser from './src/browser.js';
import { VIEWPORT_WIDTH } from './src/util.js';

const { argv } = yargs().options({
  print: {
    type: 'boolean',
    describe: "Whether to use the page's print stylesheet",
    default: false,
  },
  width: {
    type: 'string',
    describe:
      'Screenshot viewport width (e.g. 1920) or one of: mini (492), mobile (576), tablet (768), notebook (1200), laptop (1400, default), desktop (1920)',
  },
  screenshot: {
    type: 'string',
    choice: ['fullpage', 'stitched', 'none'],
    describe:
      "Screenshot method to use.\nfullpage (default): Take a screenshot of the page in one go. Does not work with very tall pages. Unresponsive pages with a horizontal scrollbar will override the viewport's width for the screenshot.\nstitched: Stitch together screenshots of the page by scrolling down the height of the viewport. Certain sticky elements may cause issues, especially when scripting is enabled, which must be fixed manually with a stylesheet.\nnone: Do not take a screenshot.",
    default: 'fullpage',
  },
  screenshotQuality: {
    type: 'number',
    default: 90,
  },
  aoUrl: {
    type: 'string',
    describe:
      'Pre-defined archive.org URL, useful when selecting a historical snapshot. "auto" (default) attempts to archive the URL. You may be prompted if the link is invalid to select a historic snapshot. "none" skips archive.org archiving.',
    default: 'auto',
  },
  atUrl: {
    type: 'string',
    describe:
      'Pre-defined archive.today URL, useful when selecting a historical snapshot. "auto" (default) attempts to archive the URL. "none" skips archive.today archiving.',
    default: 'auto',
  },
  stylesheet: {
    type: 'string',
    describe:
      'File containing the stylesheet to be used for the screenshot process. Overrides --stylesheets-dir. @import rules are supported.',
  },
  stylesheetsDir: {
    type: 'string',
    describe:
      'Directory containing stylesheets (files named origin.css, e.g. www.example.com.css) for the screenshot process. @import rules are supported',
    default: join(process.cwd(), 'stylesheets'),
  },
  filters: {
    type: 'string',
    describe:
      'File containing a list of Adblock filters to apply. Almost all filters (cosmetic and network) are supported. Defaults to <stylesheet-dir/filters.txt>',
  },
  shorturl: {
    type: 'string',
    describe:
      '5-30 characters that will be used as v.gd shorturl of the archive.org link, or "none" to disable',
  },
  exifComment: {
    type: 'string',
    describe: 'Custom text to add at the end of the EXIF description',
  },
  exifKeywords: {
    type: 'string',
    describe: 'List of keywords to add to the EXIF data, separated by commas (no spaces)',
  },
  renew: {
    type: 'string',
    choices: ['auto', 'manual', 'no'],
    describe:
      '"no" to always use the latest existing snapshot when possible. "manual" to manually determine whether to rearchive the link. "auto" (default) automatically determines whether the link is outdated. "never" to never renew',
    default: 'auto',
  },
  referrer: {
    type: 'string',
    describe:
      'Referrer site to use when visiting the site when taking a screenshot. Useful for paywalls. Presets: g: https://google.com, ddg: https://duckduckgo.com',
  },
  outputDir: { type: 'string', default: process.cwd() },
  noscript: {
    type: 'boolean',
    describe:
      'If passed, JavaScript will be disabled when taking a screenshot. Useful especially for paywall websites and obnoxious popups.',
    default: false,
  },
  imageLoadTimeout: {
    type: 'number',
    describe:
      'Timeout in milliseconds for images to load. In noscript mode, this amount of time is always elapsed to let images load.',
    default: 15000,
  },
  debug: {
    type: 'string',
    choices: ['all', 'screenshot'],
    describe:
      'screenshot: Debug the screenshotting process without saving files or archiving a URL.',
  },
});

async function main() {
  const originalArgv = { ...argv };
  if (!argv.url) {
    const extraArgs = argv._.join(' ');
    if (extraArgs) {
      argv.url = extraArgs;
    } else {
      argv.url = (
        await enquirer.prompt({ type: 'input', message: 'URL:', name: 'url' })
      ).url;
      if (!argv.width) {
        argv.width = (
          await enquirer.prompt({
            type: 'select',
            message: 'Viewport:',
            name: 'width',
            choices: Object.keys(VIEWPORT_WIDTH),
          })
        ).width;
      }
    }
  }

  if (!argv.width) argv.width = 'laptop';

  if (argv.debug === 'screenshot') {
    if (argv.aoUrl === 'auto') {
      argv.aoUrl = 'archive.org/debug';
      argv.shorturl = 'none';
    }
    if (argv.atUrl === 'auto') argv.atUrl = 'archive.today/debug';
  }

  try {
    new URL(argv.url);
  } catch (e) {
    console.error('Invalid URL specified:', argv.url);
    process.exit(1);
  }
  const { cssFilename, stylesheet } = await resolveStylesheet(argv);
  if (argv.debug) {
    console.info(
      stylesheet
        ? `Using stylesheet: ${cssFilename}`
        : `Could not find stylesheet: ${cssFilename}`
    );
  }

  let progress = ora().start(`Starting browser`);
  const browser = await launchBrowser(argv);
  process.on('SIGINT', async () => {
    await browser.close();
    process.exit();
  });

  progress.prefixText = 'Archiving URL';
  try {
    let archiveUrls = { url: argv.url };
    const activeArchiveMethods = [];
    for (const { site, exec } of archiveMethods) {
      function retryableMethod(args) {
        return reportProgress(exec(args), progress).catch(async (e) => {
          console.error(e);
          const retry = (
            await enquirer.prompt({
              type: 'confirm',
              message: `${site} failed to archive ${argv.url}. Retry?`,
              name: 'retry',
              initial: true,
            })
          ).retry;
          if (retry) {
            return retryableMethod(args);
          } else throw e;
        });
      }
      activeArchiveMethods.push(retryableMethod({ argv, browser }));
    }

    const archiveResults = await Promise.all(activeArchiveMethods);
    for (const result of archiveResults) archiveUrls = { ...archiveUrls, ...result };

    progress.prefixText = '';
    progress.succeed(`Archiving URL`);
    progress = ora().start('Screenshot');
    const { pageTitle, filename } = await reportProgress(
      screenshot({ argv, browser, archiveUrls, stylesheet }),
      progress
    );
    if (argv.debug !== 'screenshot') {
      await reportProgress(
        addExifMetadata({ argv, pageTitle, filename, archiveUrls }),
        progress
      );
    }

    progress.succeed('Screenshot');
    console.log(`File: ${filename}`);
    console.log(
      `archive.org: ${archiveUrls.archiveOrgUrl}${
        archiveUrls.archiveOrgShortUrl ? ` (${archiveUrls.archiveOrgShortUrl})` : ''
      }`
    );
    console.log(`archive.today: ${archiveUrls.archiveTodayUrl}`);
    if (argv.debug !== 'screenshot') {
      await open(`file://${filename}`);
      const launchArgv = process.argv.slice(2);
      // Add --width and --url if they are specified via the CLI
      if (!originalArgv.width) launchArgv.push('--width', argv.width);
      if (!originalArgv.url) launchArgv.push(`"${argv.url}"`);
      appendFileSync(
        join(argv.outputDir, '.archhive_history'),
        `${launchArgv.join(' ')} # ${new Date()}\n`
      );
    }
  } catch (e) {
    console.error(e);
    progress.fail(e.message);
  }

  await browser.close();
}

try {
  main();
} catch (e) {
  process.exit(1);
}

async function reportProgress(iterator, progress) {
  // This emulates for await of, but allows us to pass back the results of {prompt: ...} to yield
  let item = await iterator.next();
  while (!item.done) {
    if (typeof item.value === 'string') {
      progress.text = item.value;
      item = await iterator.next();
    } else {
      if (item.value?.prompt) {
        item = await iterator.next(await enquirer.prompt(item.value.prompt));
      } else {
        return item.value;
      }
    }
  }

  return item.value;
}