function normalizeSectionContent(section = {}) {
  const keepSpokenLine = value => typeof value === 'string' && value.trim() && !value.trim().startsWith('[');
  const joinSpokenParts = parts => parts
    .filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim())
    .reduce((result, part) => {
      if (!result) return part;
      return `${result}${/[.!?]$/.test(result) ? ' ' : '. '}${part}`;
    }, '');

  if (Array.isArray(section.content)) {
    return section.content.filter(keepSpokenLine).map(value => value.trim());
  }
  if (typeof section.content === 'string') {
    return keepSpokenLine(section.content) ? [section.content.trim()] : [];
  }
  if (Array.isArray(section.steps)) {
    return section.steps.map(step => joinSpokenParts([step.title, step.description, step.tip])).filter(Boolean);
  }
  if (Array.isArray(section.items)) {
    return section.items.map((item, index) => joinSpokenParts([
      `Number ${item.number ?? index + 1}: ${item.title || ''}`,
      item.description
    ])).filter(Boolean);
  }
  return [];
}

function getSectionSpokenText(section) {
  return normalizeSectionContent(section).join(' ');
}

function getScriptSpokenText(script = {}) {
  const parts = [];
  if (script.hook?.text) parts.push(script.hook.text);

  if (script.introduction) {
    parts.push(script.introduction.greeting, script.introduction.topicIntro,
      script.introduction.valueProposition, script.introduction.credibility);
  }

  for (const section of script.mainContent?.sections || []) {
    if (section.title) parts.push(section.title);
    parts.push(getSectionSpokenText(section));
  }

  if (script.conclusion) parts.push(...(script.conclusion.recap || []), script.conclusion.finalThought);
  if (script.callToAction) {
    const cta = script.callToAction;
    parts.push(cta.subscribe, cta.like, cta.comment, cta.nextVideo);
  }

  return parts.filter(value => typeof value === 'string' && value.trim()).join(' ');
}

function countWords(text) {
  return String(text || '').trim().match(/\S+/g)?.length || 0;
}

function estimateTextDuration(text, wordsPerMinute = 150) {
  return Math.max(1, Math.ceil(countWords(text) * 60 / wordsPerMinute));
}

function durationSeconds(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 2 && parts.every(Number.isFinite)) return parts[0] * 60 + parts[1];
  if (parts.length === 3 && parts.every(Number.isFinite)) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

function formatDuration(seconds) {
  const wholeSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
    : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

module.exports = {
  normalizeSectionContent,
  getSectionSpokenText,
  getScriptSpokenText,
  countWords,
  estimateTextDuration,
  durationSeconds,
  formatDuration
};
