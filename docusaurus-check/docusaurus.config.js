// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Translation Check',
  url: 'http://localhost',
  baseUrl: '/',
  trailingSlash: true,
  onBrokenLinks: 'ignore',
  onBrokenAnchors: 'ignore',

  // Parse Markdown the way StarRocks and celerdata-enterprise do. Their
  // `future: { v4: true }` turns every mdx1Compat option off, and with headingIds off
  // the classic `## Title {#id}` heading id is a build error. Set here directly rather
  // than through future.v4, which would also switch on unrelated v4 behaviour.
  markdown: {
    mdx1Compat: { comments: false, admonitions: false, headingIds: false },
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: require.resolve('./sidebars.js'),
          admonitions: {
            // Match StarRocks production keywords exactly
            keywords: ['experimental', 'beta', 'note', 'tip', 'info', 'caution', 'danger'],
          },
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      navbar: { title: 'Translation Check', items: [] },
      footer: { copyright: 'Translation Check' },
    }),
};

module.exports = config;
