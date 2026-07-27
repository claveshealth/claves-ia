#!/usr/bin/env node
'use strict';

/** Gera uma APP_MASTER_KEY valida (32 bytes, base64). */

const crypto = require('node:crypto');

const chave = crypto.randomBytes(32).toString('base64');

console.log('\nAdicione a linha abaixo no seu arquivo .env:\n');
console.log(`APP_MASTER_KEY=${chave}\n`);
console.log('Guarde esta chave em local seguro (cofre de senhas / secret manager).');
console.log('Ela cifra as chaves de API de LLM salvas no banco — se perde-la,');
console.log('as chaves ja salvas precisarao ser cadastradas de novo.\n');
