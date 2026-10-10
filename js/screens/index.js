// Screen registry. Each module's default export is a factory
// (params, ctx) => { el, title?, onShow?, onHide?, onDestroy?, beforeLeave?, swipeBack? }.
import today from './today.js';
import lists from './lists.js';
import settings from './settings.js';
import importScreen from './import.js';
import listDetail from './list-detail.js';
import sentences from './sentences.js';
import families from './families.js';
import practice from './practice/practice.js';
import results from './practice/results.js';

export function registerScreens(register) {
  register('today', today);
  register('lists', lists);
  register('settings', settings);
  register('import', importScreen); // modal
  register('list', listDetail); // params { listId }
  register('sentences', sentences); // params { listId }
  register('families', families); // params { listId } — make word families with Claude
  register('practice', practice, { persist: false }); // modal, params see practice.js
  register('results', results, { persist: false }); // modal
}
