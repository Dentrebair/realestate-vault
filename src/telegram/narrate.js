// What the bot says when a search finds no exact match. Written by code from the search result, so
// every area, price and property named comes from the data and nothing is guessed.
const list = (items) => items.join(', ').replace(/, ([^,]*)$/, ' and $1');

export function narrateSearch(result) {
  if (!result.configured || result.outcome === 'matches') return null;

  const c = result.criteria;
  const notes = [];
  if (result.unavailable?.length) {
    const u = result.unavailable[0];
    notes.push(`${u.title} is ${u.status === 'sold' ? 'sold' : 'reserved'} and not available.`);
  }
  if (result.excludedByDealBreaker?.length) {
    notes.push(`I left out one under construction property in ${c.area ?? 'that area'} because you do not want those.`);
  }

  let main;
  switch (result.outcome) {
    case 'recommendations': {
      const n = result.recommendations.length;
      main = `I do not have an exact match for ${c.summary}. Here ${n === 1 ? 'is the closest option' : `are the ${n} closest options`}, and each card says how it differs.`;
      if (result.droppedOverBudget?.length) {
        main += ` Also in ${c.area ?? 'that area'}, but well above your budget: ${list(result.droppedOverBudget.map((p) => `${p.title} at ${p.priceDisplay}`))}.`;
      }
      break;
    }
    case 'nothing_in_budget': {
      const over = result.droppedOverBudget.map((p) => `${p.title} at ${p.priceDisplay}`);
      main = `There are properties in ${c.area ?? 'that area'}, but all are well above your budget: ${list(over)}. Could the budget stretch, or would you like to look in another area?`;
      break;
    }
    case 'nothing_in_area': {
      const fits = result.suggestions?.areasThatFit ?? [];
      main = `I do not have anything for ${c.summary} right now.`;
      main += fits.length
        ? ` I do have a property that fits your other requirements in ${list(fits.map((a) => a.name))}. Would you like to see ${fits.length === 1 ? 'it' : 'them'}?`
        : ' Would you like to change the area, the budget or the type of property?';
      break;
    }
    default:
      main = `I do not have anything that fits ${c.summary}. Which of those could change: the area, the budget or the size?`;
  }
  return [main, ...notes].join(' ');
}
