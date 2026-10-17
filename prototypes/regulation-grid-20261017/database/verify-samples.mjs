import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

// 운영 DB에 연결하지 않는다. 새 메모리 엔진에서 전체 샘플 실행을 확인한다.
const db = new PGlite();
try {
  for (const name of ['schema.sql', 'seed.sql', 'samples.sql']) {
    await db.exec(await readFile(new URL(name, import.meta.url), 'utf8'));
  }
  console.log('SAMPLES_EXEC_PASS — schema + seed + samples, 격리 메모리 DB');
} finally {
  await db.close();
}
