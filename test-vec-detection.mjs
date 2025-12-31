import { resolveConfig } from './dist/config.js';
try {
  const config = resolveConfig();
  console.log('Vector extension path:', config.vecLibPath || 'NOT FOUND');
  if (config.vecLibPath) {
    console.log('✓ sqlite-vec encontrado automaticamente!');
  } else {
    console.log('✗ sqlite-vec não encontrado');
  }
} catch (e) {
  console.error('Error:', e.message);
  process.exit(1);
}
