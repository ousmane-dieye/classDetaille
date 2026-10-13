/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-prisma-outside-repositories',
      comment: 'Seuls les *.repository.ts (et le module database) importent Prisma (§ 1.2, règle 5).',
      severity: 'error',
      from: { pathNot: ['\\.repository\\.ts$', '/src/database/', '/src/generated/'] },
      to: { path: ['/src/generated/prisma/', '^node_modules/@prisma/', '^node_modules/\\.pnpm/@prisma'] },
    },
    {
      name: 'no-foreign-repository',
      comment: "Un module n'importe jamais le repository d'un autre module.",
      severity: 'error',
      from: { path: '/src/modules/([^/]+)/' },
      to: { path: '/src/modules/([^/]+)/[^/]+\\.repository\\.ts$', pathNot: '/src/modules/$1/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: require('node:path').join(__dirname, 'apps/api/tsconfig.json') },
  },
};
