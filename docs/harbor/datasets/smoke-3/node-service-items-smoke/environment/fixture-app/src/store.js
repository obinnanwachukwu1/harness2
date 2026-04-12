const fs = require('node:fs');
const path = require('node:path');

const itemsFile = path.join(process.cwd(), 'data', 'items.json');

const fallbackItems = [
  {
    id: 'item-3',
    name: 'Gamma',
    status: 'queued',
    createdAt: '2026-01-05T10:30:00.000Z',
  },
  {
    id: 'item-2',
    name: 'Beta',
    status: 'active',
    createdAt: '2026-01-03T09:00:00.000Z',
  },
  {
    id: 'item-1',
    name: 'Alpha',
    status: 'done',
    createdAt: '2026-01-01T12:00:00.000Z',
  },
];

function readItems() {
  if (!fs.existsSync(itemsFile)) {
    return fallbackItems.slice();
  }

  const raw = fs.readFileSync(itemsFile, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : fallbackItems.slice();
}

module.exports = {
  readItems,
  itemsFile,
};
