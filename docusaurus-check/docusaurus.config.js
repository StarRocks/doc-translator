// @ts-check

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'Translation Check',
  url: 'http://localhost',
  baseUrl: '/',
  trailingSlash: true,
  onBrokenLinks: 'ignore',
  onBrokenAnchors: 'ignore',

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
