"""Display hierarchy based only on explicit refinement ancestry, never prerequisites."""
MAX_DEPTH = 4


def hierarchy(nodes):
    """Return stable preorder entries without mutating node data.

    Missing/self parents become roots. Break each cycle at its first input node,
    so malformed legacy data remains visible and ordering is deterministic.
    """
    nodes = [node for node in nodes if isinstance(node, dict)]
    by_id = {str(node['id']): node for node in nodes if node.get('id') is not None}
    parents = {}
    for node_id, node in by_id.items():
        remediation = node.get('remediation')
        parent = remediation.get('parent') if isinstance(remediation, dict) else None
        parents[node_id] = parent if isinstance(parent, str) and parent in by_id and parent != node_id else None
    positions = {node_id: index for index, node_id in enumerate(by_id)}
    settled = set()
    for node_id in by_id:
        chain, offsets = [], {}
        current = node_id
        while current is not None and current not in settled:
            if current in offsets:
                cycle = chain[offsets[current]:]
                parents[min(cycle, key=positions.get)] = None
                break
            offsets[current] = len(chain)
            chain.append(current)
            current = parents[current]
        settled.update(chain)
    children = {None: []}
    for node_id, parent in parents.items():
        children.setdefault(parent, []).append(node_id)
    result = []
    stack = [(node_id, str(index + 1), node_id) for index, node_id in reversed(list(enumerate(children[None])))]
    while stack:
        node_id, number, root_id = stack.pop()
        result.append({'node': by_id[node_id], 'label': 'L' + number,
                       'depth': number.count('.') + 1, 'root_id': root_id,
                       'parent_id': parents[node_id]})
        stack.extend((child, number + '.' + str(index + 1), root_id)
                     for index, child in reversed(list(enumerate(children.get(node_id, [])))))
    return result


def canonicalize_plan(plan):
    """Reorder nodes only; ids, ancestry, learning dependencies and edges survive."""
    return {**plan, 'nodes': [entry['node'] for entry in hierarchy(plan.get('nodes') or [])]}


def ensure_refinable(plan, parent_ids):
    entries = {str(entry['node']['id']): entry for entry in hierarchy(plan.get('nodes') or [])}
    for parent_id in parent_ids:
        if parent_id not in entries:
            raise ValueError('细化单元无法关联原节点，请重试')
        if entries[parent_id]['depth'] >= MAX_DEPTH:
            raise ValueError('学习路径最多支持四层细化，当前单元已达到层级上限')
