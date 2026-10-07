export const FLIGHT_DECK_APP_TITLE = 'Wingman: Deck';

function cleanTitlePart(value) {
  return String(value || '').trim();
}

function buildSectionTitle(label, { workspaceLabel = '', detailLabel = '' } = {}) {
  const titleParts = [
    cleanTitlePart(label),
    cleanTitlePart(workspaceLabel),
    cleanTitlePart(detailLabel),
  ].filter(Boolean);

  return `${titleParts.join(' | ')} - ${FLIGHT_DECK_APP_TITLE}`;
}

export function buildFlightDeckDocumentTitle({
  section = 'chat',
  channelLabel = '',
  folderLabel = '',
  docTitle = '',
  workspaceLabel = '',
} = {}) {
  const nextSection = String(section || 'chat').trim().toLowerCase();
  const nextChannelLabel = String(channelLabel || '').trim();
  const nextFolderLabel = String(folderLabel || '').trim();
  const nextDocTitle = String(docTitle || '').trim();
  const nextWorkspaceLabel = String(workspaceLabel || '').trim();

  switch (nextSection) {
    case 'status':
      return buildSectionTitle('Deck', { workspaceLabel: nextWorkspaceLabel });
    case 'toolbox':
      return buildSectionTitle('Toolbox', { workspaceLabel: nextWorkspaceLabel });
    case 'context':
      return buildSectionTitle('Context Tree', { workspaceLabel: nextWorkspaceLabel });
    case 'tasks':
      return buildSectionTitle('Tasks', { workspaceLabel: nextWorkspaceLabel });
    case 'docs':
      if (nextDocTitle) return buildSectionTitle('Docs', { workspaceLabel: nextWorkspaceLabel, detailLabel: nextDocTitle });
      if (nextFolderLabel) return buildSectionTitle('Docs', { workspaceLabel: nextWorkspaceLabel, detailLabel: nextFolderLabel });
      return buildSectionTitle('Docs', { workspaceLabel: nextWorkspaceLabel });
    case 'files':
      return buildSectionTitle('Files', { workspaceLabel: nextWorkspaceLabel });
    case 'workroom':
      return buildSectionTitle('Workroom', { workspaceLabel: nextWorkspaceLabel });
    case 'opportunities':
      return buildSectionTitle('Opportunities', { workspaceLabel: nextWorkspaceLabel });
    case 'people':
      return buildSectionTitle('People', { workspaceLabel: nextWorkspaceLabel });
    case 'settings':
      return buildSectionTitle('Setup', { workspaceLabel: nextWorkspaceLabel });
    case 'chat':
    default:
      if (nextChannelLabel) return buildSectionTitle('Chat', { workspaceLabel: nextWorkspaceLabel, detailLabel: nextChannelLabel });
      return buildSectionTitle('Chat', { workspaceLabel: nextWorkspaceLabel });
  }
}
