export const STAGES = [
    {id: 'auth', label: 'Verify sign-in', hint: 'Your MyMiniFactory session', start: 0, end: 8},
    {id: 'store', label: 'Find listings', hint: 'Public object listings', start: 8, end: 22},
    {id: 'objects', label: 'Read object data', hint: 'Images, categories and files', start: 22, end: 38},
    {id: 'collections', label: 'Map collections', hint: 'Every collection membership', start: 38, end: 68},
    {id: 'details', label: 'Enrich listings', hint: 'Descriptions and tags', start: 68, end: 96},
    {id: 'download', label: 'Create CSV', hint: 'Save the finished export', start: 96, end: 100},
];

export function progressPercent({stage, completed = 0, total = 0, subcompleted = 0, subtotal = 0, outcome}) {
    if (outcome === 'complete') return 100;
    const current = STAGES.find(item => item.id === stage);
    if (!current) return 0;
    const fraction = total > 0 ? Math.max(0, Math.min(1,
        (completed + (subtotal > 0 ? Math.max(0, Math.min(1, subcompleted / subtotal)) : 0)) / total)) : 0;
    return Math.round(current.start + (current.end - current.start) * fraction);
}
