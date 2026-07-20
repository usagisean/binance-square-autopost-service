function unique(items = []) {
  return [...new Set(items.map(s => String(s || '').trim().toUpperCase()).filter(Boolean))];
}

const ASSET_UNIVERSE = {
  crypto_core: unique(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'PEPE', 'WIF', 'BONK', 'PENGU', 'BABY', 'SUI', 'ENA', 'LINK', 'AAVE', 'AVAX', 'ADA', 'ZEC', 'BOB']),
  crypto_ai: unique(['NEAR', 'ICP', 'RENDER', 'FET', 'TAO', 'ARKM', 'WLD', 'VIRTUAL', 'AI', 'COOKIE', 'GRASS', 'IO', 'ATH', 'NMR']),
  crypto_high_volatility: unique(['MYX', 'BSB', 'PIPPIN', 'RAVE', 'CHIP', 'TST', 'DOGS', 'NOT', 'DYM', 'CFG', 'HIVE', 'STEEM', 'PLUME', 'HIFI', 'HIGH', 'HUMA', 'SOPH', 'AIXBT', 'VANA', '1000SATS', 'ORDI', 'SAGA', 'MANTA', 'OMNI', 'NFP', 'PORTAL', 'ACE', 'PIXEL', 'BIGTIME', 'LISTA', 'ZK', 'ZRO', 'KAITO', 'BERA', 'TRUMP', 'DOOD', 'VINE', 'BROCCOLI']),
  stock_ai: unique(['NVDA', 'AMD', 'AVGO', 'TSM', 'ARM', 'MU', 'SMCI', 'PLTR', 'MSFT', 'GOOGL', 'META', 'AMZN', 'TSLA', 'CRWV', 'ORCL', 'VRT']),
  stock_crypto_beta: unique(['COIN', 'MSTR', 'HOOD']),
  etf_macro: unique(['QQQ', 'SOXX', 'SPY'])
};

const LEGACY_CONTRACT_META = {
  BTC: { name: 'Bitcoin', bucket: 'anchor' }, ETH: { name: 'Ethereum', bucket: 'anchor' },
  SOL: { name: 'Solana', bucket: 'major-beta' }, BNB: { name: 'BNB', bucket: 'major-beta' }, XRP: { name: 'XRP', bucket: 'major-beta' },
  DOGE: { name: 'Dogecoin', bucket: 'meme' }, PEPE: { name: 'PEPE', bucket: 'meme' }, WIF: { name: 'dogwifhat', bucket: 'meme' },
  BONK: { name: 'Bonk', bucket: 'meme' }, BOME: { name: 'BOOK OF MEME', bucket: 'meme' }, FLOKI: { name: 'FLOKI', bucket: 'meme' },
  POPCAT: { name: 'Popcat', bucket: 'meme' }, PENGU: { name: 'Pudgy Penguins', bucket: 'meme' }, FARTCOIN: { name: 'Fartcoin', bucket: 'meme' },
  AAVE: { name: 'AAVE', bucket: 'defi' }, LINK: { name: 'Chainlink', bucket: 'infra' }, ARB: { name: 'Arbitrum', bucket: 'beta' },
  ENA: { name: 'Ethena', bucket: 'beta' }, FET: { name: 'Artificial Superintelligence Alliance', bucket: 'ai' }, SUI: { name: 'Sui', bucket: 'beta' },
  AVAX: { name: 'Avalanche', bucket: 'beta' }, ADA: { name: 'Cardano', bucket: 'beta' }, ZEC: { name: 'Zcash', bucket: 'beta' }, POL: { name: 'POL', bucket: 'beta' },
  ALPACA: { name: 'Alpaca Finance', bucket: 'bnb-beta' }, ALPHA: { name: 'Alpha Finance', bucket: 'bnb-beta' }, BAKE: { name: 'BakerySwap', bucket: 'bnb-beta' },
  BSW: { name: 'Biswap', bucket: 'bnb-beta' }, MBOX: { name: 'Mobox', bucket: 'bnb-beta' }, LOKA: { name: 'League of Kingdoms', bucket: 'beta' },
  RAVE: { name: 'RAVE', bucket: 'contract-meme' }, CHIP: { name: 'CHIP', bucket: 'contract-meme' }, BSB: { name: 'BSB', bucket: 'contract-meme' }
};

const EXTRA_CONTRACT_META = {
  BABY: { name: 'Baby', bucket: 'meme' }, BOB: { name: 'BOB', bucket: 'beta' },
  NEAR: { name: 'NEAR Protocol', bucket: 'ai' }, ICP: { name: 'Internet Computer', bucket: 'ai' }, RENDER: { name: 'Render', bucket: 'ai' },
  TAO: { name: 'Bittensor', bucket: 'ai' }, ARKM: { name: 'Arkham', bucket: 'ai' }, WLD: { name: 'Worldcoin', bucket: 'ai' },
  VIRTUAL: { name: 'Virtuals Protocol', bucket: 'ai' }, AI: { name: 'Sleepless AI', bucket: 'ai' }, COOKIE: { name: 'Cookie DAO', bucket: 'ai' },
  GRASS: { name: 'Grass', bucket: 'ai' }, IO: { name: 'io.net', bucket: 'ai' }, ATH: { name: 'Aethir', bucket: 'ai' }, NMR: { name: 'Numeraire', bucket: 'ai' },
  MYX: { name: 'MYX Finance', bucket: 'high-vol' }, PIPPIN: { name: 'Pippin', bucket: 'high-vol' }, TST: { name: 'TST', bucket: 'contract-meme' },
  DOGS: { name: 'Dogs', bucket: 'meme' }, NOT: { name: 'Notcoin', bucket: 'beta' }, DYM: { name: 'Dymension', bucket: 'beta' }, CFG: { name: 'Centrifuge', bucket: 'beta' },
  HIVE: { name: 'Hive', bucket: 'high-vol' }, STEEM: { name: 'Steem', bucket: 'high-vol' }, UTK: { name: 'xMoney', bucket: 'high-vol' }, PLUME: { name: 'Plume', bucket: 'beta' },
  HIFI: { name: 'Hifi Finance', bucket: 'high-vol' }, HIGH: { name: 'Highstreet', bucket: 'high-vol' }, HUMA: { name: 'Huma Finance', bucket: 'beta' }, SOPH: { name: 'Sophon', bucket: 'beta' },
  AIXBT: { name: 'aixbt', bucket: 'ai' }, VANA: { name: 'Vana', bucket: 'ai' }, ORDI: { name: 'Ordinals', bucket: 'high-vol' }, SAGA: { name: 'Saga', bucket: 'beta' },
  MANTA: { name: 'Manta', bucket: 'beta' }, OMNI: { name: 'Omni Network', bucket: 'beta' }, NFP: { name: 'NFPrompt', bucket: 'ai' }, PORTAL: { name: 'Portal', bucket: 'high-vol' },
  ACE: { name: 'Fusionist', bucket: 'high-vol' }, PIXEL: { name: 'Pixels', bucket: 'high-vol' }, BIGTIME: { name: 'Big Time', bucket: 'high-vol' }, LISTA: { name: 'Lista', bucket: 'beta' },
  ZK: { name: 'zkSync', bucket: 'beta' }, ZRO: { name: 'LayerZero', bucket: 'beta' }, KAITO: { name: 'Kaito', bucket: 'ai' }, BERA: { name: 'Berachain', bucket: 'beta' }, TRUMP: { name: 'Official Trump', bucket: 'meme' },
  DOOD: { name: 'Doodles', bucket: 'high-vol' }, VINE: { name: 'Vine', bucket: 'high-vol' }, BROCCOLI: { name: 'Broccoli', bucket: 'contract-meme' }
};

const CONTRACT_META = { ...LEGACY_CONTRACT_META, ...EXTRA_CONTRACT_META };

const LEGACY_PRIORITY_SYMBOLS = unique([
  'CHIP', 'RAVE', 'BSB', 'ALPACA', 'ALPHA', 'BAKE', 'BSW', 'MBOX', 'LOKA',
  'DOGE', 'PEPE', 'WIF', 'BONK', 'BOME', 'FLOKI', 'POPCAT', 'PENGU', 'FARTCOIN',
  'ENA', 'FET', 'SUI', 'ARB', 'AAVE', 'LINK', 'AVAX', 'SOL', 'BNB', 'XRP', 'ZEC'
]);

const PRIORITY_SYMBOLS = unique([
  ...ASSET_UNIVERSE.crypto_high_volatility,
  ...ASSET_UNIVERSE.crypto_ai,
  ...ASSET_UNIVERSE.crypto_core,
  ...LEGACY_PRIORITY_SYMBOLS
]);

const EXCLUDED_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'USD1', 'USDE', 'USDS', 'DAI',
  'EUR', 'GBP', 'TRY', 'UAH', 'RUB', 'AUD', 'BRL'
]);

const MEME_SYMBOL_PATTERN = /DOGE|PEPE|WIF|BONK|BOME|FLOKI|POPCAT|PENGU|FART|SHIB|MEME|CHILL|MOODENG|MOG|NEIRO|ACT|TST|TURBO|BRETT|MEW|RAVE|CHIP|BSB|BABY/i;

const DEFAULT_SQUARE_TAG_SYMBOLS = unique([
  ...ASSET_UNIVERSE.crypto_core,
  ...ASSET_UNIVERSE.crypto_ai,
  ...ASSET_UNIVERSE.crypto_high_volatility,
  'BOME', 'FLOKI', 'POPCAT', 'FARTCOIN', 'ARB', 'POL'
]);

const DEFAULT_BANNED_PHRASES = unique([
  '主动腿', '拧巴', '玄学', '抽象', '离谱', '绷不住', '上头', '杀疯了', '起飞', '爆拉', '闭眼', '梭哈', '铁子', '兄弟们',
  '稳赚', '必涨', '无脑冲', '闭眼买', '稳了', '主线', '风险锚', '对照腿', '情绪锚', '带节奏的是', '盘面最有张力',
  '我的计划很简单', '我的处理是', '计划偏多', '计划偏空', '条件计划', '只做条件', '这轮我只按', '这轮只看', '这笔我还是按', '我这边只盯',
  '现在更适合按条件处理', '参照看', '先看分化', '继续观察', '等确认', '宏观层面', '叙事驱动', '资金共振', '多维度分析', '综合来看', '值得重点关注',
  '这单我不碰', '这单不碰', '我不碰', '压住手', '反抽', '承接', '容错低', '失效', '止损', '进场', '开多', '开空',
  '主流没配合', '外部没给顺风', '顺风', '不做也是交易', '交易计划', '触发位', '放弃条件',
  '接戏', '多空在争', '立方向', '消耗动量', '价格已经动过一轮', '注意力却还没真正跟上',
  '热闹留不住', '卡在半路', '值得点开', '值得看', '多看一眼', '谁先拿下', '才谈得上',
  '多数人最常看错的是', '多数人只盯着', '真正该看的是', '这才是这次变化的关键所在',
  '别只盯着涨跌幅', '这次变化是真强', '这次变化是真弱', '盘中更像分歧', '这截变化是分歧',
  '落在分歧', '参与支持', '强度滞后', '同级强度', '同等强度', '这一截', '这截', '近端', '读成', '领先出来'
]);

function cashtagList(symbols = []) {
  return unique(symbols).map(s => `$${s}`).join(' ');
}

function allTrackedCryptoSymbols() {
  return unique([...ASSET_UNIVERSE.crypto_core, ...ASSET_UNIVERSE.crypto_ai, ...ASSET_UNIVERSE.crypto_high_volatility, ...LEGACY_PRIORITY_SYMBOLS]);
}

module.exports = {
  ASSET_UNIVERSE,
  CONTRACT_META,
  PRIORITY_SYMBOLS,
  EXCLUDED_BASES,
  MEME_SYMBOL_PATTERN,
  DEFAULT_SQUARE_TAG_SYMBOLS,
  DEFAULT_BANNED_PHRASES,
  cashtagList,
  allTrackedCryptoSymbols,
  unique
};
