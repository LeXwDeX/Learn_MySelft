"""Ancestry, ordering and four-level refinement boundary regressions."""

import copy
import json
import unittest
from unittest.mock import patch
import test_state_regressions as base
import generation_contracts as contracts
import flywheel
import path_hierarchy


def node(node_id, parent=None, deps=()):
    value = {"id": node_id, "title": node_id, "deps": list(deps)}
    if parent is not None:
        value["remediation"] = {"parent": parent}
    return value


class HierarchyTests(unittest.TestCase):
    def test_preorder_uses_ancestry_not_learning_dependencies(self):
        nodes = [
            node("n1"),
            node("n2", deps=["n1"]),
            node("n3", "n1"),
            node("n4", "n3"),
            node("n5", "n1"),
            node("n6", "n4"),
        ]
        original = copy.deepcopy(nodes)
        entries = path_hierarchy.hierarchy(nodes)
        self.assertEqual(
            [item["node"]["id"] for item in entries],
            ["n1", "n3", "n4", "n6", "n5", "n2"],
        )
        self.assertEqual(
            [item["label"] for item in entries],
            ["L1", "L1.1", "L1.1.1", "L1.1.1.1", "L1.2", "L2"],
        )
        self.assertEqual([item["depth"] for item in entries], [1, 2, 3, 4, 2, 1])
        self.assertEqual(nodes, original)
        plan = {"nodes": nodes, "edges": [["n1", "n2"]]}
        normalized = path_hierarchy.canonicalize_plan(plan)
        self.assertEqual(normalized["edges"], plan["edges"])
        self.assertEqual(path_hierarchy.canonicalize_plan(normalized), normalized)

    def test_orphans_self_links_and_cycles_remain_visible(self):
        nodes = [
            node("a", "b"),
            node("b", "a"),
            node("c", "missing"),
            node("d", "d"),
            node("e", "b"),
        ]
        entries = path_hierarchy.hierarchy(nodes)
        self.assertEqual(
            [item["node"]["id"] for item in entries], ["a", "b", "e", "c", "d"]
        )
        self.assertEqual(
            [item["label"] for item in entries], ["L1", "L1.1", "L1.1.1", "L2", "L3"]
        )
        self.assertEqual(entries[0]["parent_id"], None)
        self.assertEqual(entries[2]["root_id"], "a")

    def test_dotted_parent_labels_do_not_resolve_to_root(self):
        nodes = [node("n1"), node("n2"), node("n3", "n1"), node("n4", "n3")]
        ids = {item["id"] for item in nodes}
        for text, expected in [
            ("L1.1 title", "n3"),
            ("1.1.1", "n4"),
            ("L2", "n2"),
            ("n3", "n3"),
            ("L1.9", ""),
            ("L1.1.1.1.1", ""),
        ]:
            self.assertEqual(
                contracts._resolve_refine_parent(text, nodes, ids), expected
            )

    def test_quiz_labels_support_hierarchy_and_historical_titles(self):
        nodes = [node("n1"), node("n2"), node("n3", "n1"), node("n4")]
        nodes[2]["title"] = "Remedial basics"
        nodes[3]["title"] = "Advanced practice"
        plan = {"nodes": nodes}
        self.assertEqual(flywheel.node_id("L1.1", plan), "n3")
        self.assertEqual(flywheel.node_id("L3", plan), "n4")
        self.assertEqual(flywheel.node_id("L3 Remedial basics", plan), "n3")
        self.assertEqual(flywheel.node_id("L4", plan), "n4")
        self.assertIsNone(flywheel.node_id("L1.7", plan))


class RefinementHierarchyTests(unittest.TestCase):
    def setUp(self):
        self.case = base.StateRegressionTests()
        self.case.setUp()
        self.app = self.case.app
        self.addCleanup(self.case.doCleanups)

    def test_unreceipted_nested_refinement_persists_parent_and_preorder(self):
        self.assertEqual(self.case.refine(nid="n1")[0], 200)
        self.assertEqual(self.case.refine(nid="n3")[0], 200)
        self.assertEqual(self.case.refine(nid="n4")[0], 200)
        plan = self.case.material()["plan"]
        self.assertEqual(
            [item["id"] for item in plan["nodes"]], ["n1", "n3", "n4", "n5", "n2"]
        )
        self.assertEqual(plan["nodes"][3]["remediation"], {"parent": "n4"})
        before = self.case.material()
        with patch.object(self.app.model, "nonempty") as model:
            status, response = self.case.post(
                "/path/refine", {"key": base.KEY, "weaknesses": [{"nid": "n5"}]}
            )
        self.assertEqual(status, 400)
        self.assertIn("四层", response["error"])
        model.assert_not_called()
        self.assertEqual(self.case.material(), before)

    def test_transaction_rechecks_depth_and_rolls_back_entire_batch(self):
        material = self.case.material()
        material["plan"]["nodes"] += [
            node("n3", "n1"),
            node("n4", "n3"),
            node("n5", "n4"),
        ]
        self.app.repository.write_key(base.KEY, json.dumps(material))
        units = [
            {"for": parent, "title": "New", "essence": "", "objectives": []}
            for parent in ["n1", "n5"]
        ]
        with self.assertRaisesRegex(ValueError, "四层"):
            self.app.repository.append_refinement(base.KEY, base.PLAN, units, "receipt")
        self.assertEqual(self.case.material(), material)

    def test_receipt_reuse_precedes_depth_validation(self):
        material = self.case.material()
        material["plan"]["nodes"] += [
            node("n3", "n1"),
            node("n4", "n3"),
            node("n5", "n4"),
        ]
        material["refinementReceipts"] = {
            "done": {"ok": True, "added": 1, "node_ids": ["n5"]}
        }
        self.app.repository.write_key(base.KEY, json.dumps(material))
        result = self.app.repository.append_refinement(
            base.KEY, {}, [{"for": "n5"}], "done"
        )
        self.assertEqual(result, material["plan"])
        self.assertEqual(self.case.material(), material)

    def test_concurrent_ancestry_change_is_rechecked_after_generation(self):
        changed_material = self.case.material()
        changed_material["plan"]["nodes"] = [
            node("n6"),
            node("n7", "n6"),
            node("n8", "n7"),
            node("n1", "n8"),
            node("n2"),
        ]

        def generate(*args, **kwargs):
            self.app.repository.write_key(base.KEY, json.dumps(changed_material))
            return json.dumps({"units": [{"for": "n1", "title": "Late child"}]})

        with patch.object(self.app.model, "nonempty", side_effect=generate):
            status, response = self.case.post(
                "/path/refine", {"key": base.KEY, "weaknesses": [{"nid": "n1"}]}
            )
        self.assertEqual(status, 409)
        self.assertIn("四层", response["error"])
        self.assertEqual(self.case.material(), changed_material)
        self.assertFalse(self.app.cache.gates)
