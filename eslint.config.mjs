import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/generated/**', '**/node_modules/**', 'apps/api/test/architecture/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
