//! Dots on wires (05 §9.2, 06 §6.6): points of a network that a wire's route
//! goes through. A dot has one input — every wire through it comes from one
//! source; an unpinned dot no wire goes through goes, a pinned one stays.
//! The links between the nodes are the wires' (05 §8): a dot changes only
//! how a wire is drawn in its network.
//!
//! The network's document keeps them (10 §2.4): `dot` — `{ x, y, pinned }`
//! by the dot's id, `route` — `{ dots: [id…] }` by the wire's key.

use super::{Result, Store, Val, Workspace, Writes, invalid, read};
use loro::LoroValue;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use strata_model::{DotId, NodeId};

/// A dot of the network on the canvas (05 §9.2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ViewDot {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub pinned: bool,
}

/// A dot's place and whether it is pinned.
type Dot = (f64, f64, bool);

/// A dot as the network's document keeps it (10 §2.4).
pub(super) fn dot_val((x, y, pinned): Dot) -> Val {
    Val::map([
        ("x", Val::Float(x)),
        ("y", Val::Float(y)),
        ("pinned", Val::Bool(pinned)),
    ])
}

/// [`dot_val`] read back.
fn dot_of(v: &Val) -> Option<Dot> {
    Some((
        v.get("x")?.as_f64()?,
        v.get("y")?.as_f64()?,
        matches!(v.get("pinned"), Some(Val::Bool(true))),
    ))
}

/// A wire's route (10 §2.4): the dots it goes through, in order.
pub(super) fn route_val(dots: &[String]) -> Val {
    Val::map([(
        "dots",
        Val::List(dots.iter().map(|d| Val::str(d.clone())).collect()),
    )])
}

/// [`route_val`] read back.
fn route_of(v: &Val) -> Vec<String> {
    match v.get("dots") {
        Some(Val::List(l)) => l
            .iter()
            .filter_map(|d| d.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// The ends of a wire as its index entry names them; none for a ghost's (05 §8.5).
fn ends_of(v: &Val) -> Option<(NodeId, NodeId)> {
    let end = |k: &str| {
        v.get(k)
            .and_then(Val::as_str)
            .and_then(|s| NodeId::parse(s).ok())
    };
    Some((end("from")?, end("to")?))
}

/// The dots and routes as the operations of a step so far leave them: the
/// later operations of one step see what the earlier ones did.
#[derive(Debug, Default)]
pub(super) struct DotOverlay {
    dots: HashMap<(String, String), Option<Dot>>,
    routes: HashMap<(String, String), Option<Vec<String>>>,
    /// Wires the step made, by key: their ends.
    pub made: HashMap<String, (NodeId, NodeId)>,
    /// Wires the step took away, by key.
    pub gone: HashSet<String>,
}

/// The last write of each key of the dots, the routes, the wires and the
/// placements in a step's writes: what the step leaves.
type Last = HashMap<(String, String, String), Option<Val>>;

impl<S: Store> Workspace<S> {
    /// The dots kept in network document `doc`, by id.
    fn dots_in(&self, doc: &str) -> BTreeMap<String, Dot> {
        let mut out = BTreeMap::new();
        if let Some(d) = self.docs.get(doc)
            && let LoroValue::Map(m) = d.get_map("dot").get_value()
        {
            for (k, v) in m.iter() {
                if let Some(p) = Val::from_loro(v).as_ref().and_then(dot_of) {
                    out.insert(k.clone(), p);
                }
            }
        }
        out
    }

    /// The routes kept in network document `doc`: wire key → dots.
    fn routes_in(&self, doc: &str) -> BTreeMap<String, Vec<String>> {
        let mut out = BTreeMap::new();
        if let Some(d) = self.docs.get(doc)
            && let LoroValue::Map(m) = d.get_map("route").get_value()
        {
            for (k, v) in m.iter() {
                let dots = Val::from_loro(v).as_ref().map(route_of).unwrap_or_default();
                if !dots.is_empty() {
                    out.insert(k.clone(), dots);
                }
            }
        }
        out
    }

    /// The ends of the wire with key `edge`, whichever shard keeps it; none
    /// for a ghost's wire and for one that is not.
    pub(super) fn edge_ends(&self, edge: &str) -> Option<(NodeId, NodeId)> {
        self.index_shards()
            .find_map(|shard| read(shard, "edge", edge))
            .as_ref()
            .and_then(ends_of)
    }

    /// Dot `id` of network `net` as the step so far leaves it.
    fn dot_now(&self, ov: &DotOverlay, net: &str, id: &str) -> Option<Dot> {
        match ov.dots.get(&(net.to_owned(), id.to_owned())) {
            Some(v) => *v,
            None => self
                .docs
                .get(&format!("net/{net}"))
                .and_then(|d| read(d, "dot", id))
                .as_ref()
                .and_then(dot_of),
        }
    }

    /// The routes of network `net` as the step so far leaves them.
    fn routes_now(&self, ov: &DotOverlay, net: &str) -> BTreeMap<String, Vec<String>> {
        let mut out = self.routes_in(&format!("net/{net}"));
        for ((n, edge), v) in &ov.routes {
            if n != net {
                continue;
            }
            match v {
                Some(dots) => out.insert(edge.clone(), dots.clone()),
                None => out.remove(edge),
            };
        }
        out
    }

    /// `PutDot` checked (06 §6.6): a dot of a network's canvas, at a place.
    pub(super) fn plan_put_dot(
        &self,
        ov: &mut DotOverlay,
        net: &str,
        id: &str,
        dot: Dot,
        put: &mut impl FnMut(&str, &str, &str, Option<Val>),
    ) -> Result<()> {
        let id = DotId::parse(id)
            .map_err(|_| invalid(format!("{id} is no dot's id")))?
            .to_text();
        if !dot.0.is_finite() || !dot.1.is_finite() {
            return Err(invalid(format!("dot {id}: its place is not a number")));
        }
        put(&format!("net/{net}"), "dot", &id, Some(dot_val(dot)));
        ov.dots.insert((net.to_owned(), id), Some(dot));
        Ok(())
    }

    /// `RemoveDot` checked (06 §6.6): the wires through the dot go straight.
    pub(super) fn plan_remove_dot(
        &self,
        ov: &mut DotOverlay,
        net: &str,
        id: &str,
        put: &mut impl FnMut(&str, &str, &str, Option<Val>),
    ) -> Result<()> {
        if self.dot_now(ov, net, id).is_none() {
            return Err(invalid(format!("there is no dot {id} in {net}")));
        }
        let doc = format!("net/{net}");
        for (edge, dots) in self.routes_now(ov, net) {
            if !dots.iter().any(|d| d == id) {
                continue;
            }
            let rest: Vec<String> = dots.into_iter().filter(|d| d != id).collect();
            put(
                &doc,
                "route",
                &edge,
                (!rest.is_empty()).then(|| route_val(&rest)),
            );
            ov.routes
                .insert((net.to_owned(), edge), (!rest.is_empty()).then_some(rest));
        }
        put(&doc, "dot", id, None);
        ov.dots.insert((net.to_owned(), id.to_owned()), None);
        Ok(())
    }

    /// `SetRoute` checked (05 §9.2, 06 §6.6): a wire that is, between nodes
    /// placed in the network, through its dots, each once; every wire
    /// through a dot comes from the same source.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn plan_route(
        &self,
        ov: &mut DotOverlay,
        net: &str,
        (a, b): (NodeId, NodeId),
        edge: &str,
        placed: bool,
        dots: &[String],
        put: &mut impl FnMut(&str, &str, &str, Option<Val>),
    ) -> Result<()> {
        let is = ov.made.contains_key(edge)
            || (!ov.gone.contains(edge) && self.edge_ends(edge).is_some());
        if !is {
            return Err(invalid("there is no such wire"));
        }
        if !placed {
            return Err(invalid(format!(
                "the wire {} → {} is not seen in {net}",
                a.to_text(),
                b.to_text()
            )));
        }
        let routes = self.routes_now(ov, net);
        let mut seen = HashSet::new();
        for d in dots {
            if !seen.insert(d) {
                return Err(invalid(format!("a route goes through dot {d} once")));
            }
            if self.dot_now(ov, net, d).is_none() {
                return Err(invalid(format!("there is no dot {d} in {net}")));
            }
            // One input (06 §6.6): the wires through a dot share their source.
            for (other, through) in &routes {
                if other == edge || !through.contains(d) {
                    continue;
                }
                let source = ov
                    .made
                    .get(other)
                    .copied()
                    .or_else(|| self.edge_ends(other))
                    .map(|(f, _)| f);
                if source.is_some_and(|f| f != a) {
                    return Err(invalid(format!(
                        "dot {d}: the wires through a dot come from one source (06 §6.6)"
                    )));
                }
            }
        }
        let route = (!dots.is_empty()).then(|| dots.to_vec());
        put(
            &format!("net/{net}"),
            "route",
            edge,
            route.as_deref().map(route_val),
        );
        ov.routes.insert((net.to_owned(), edge.to_owned()), route);
        Ok(())
    }

    /// What follows a step's writes for the dots (05 §9.2, 06 §6.6): a wire
    /// that goes loses its route in every network it was seen in, a node that
    /// leaves a network takes its wires' routes there along, and an unpinned
    /// dot no route names any more goes. Appended to `plan`, so undo takes
    /// them back with the step.
    pub(super) fn follow_dots(&mut self, plan: &mut Writes) -> Result<()> {
        let mut last: Last = HashMap::new();
        for (doc, map, key, v) in plan.iter() {
            let ours = if doc.starts_with("index/") {
                map == "edge" || map == "placement"
            } else {
                doc.starts_with("net/") && (map == "dot" || map == "route")
            };
            if ours {
                last.insert((doc.clone(), map.clone(), key.clone()), v.clone());
            }
        }
        if last.is_empty() {
            return Ok(());
        }
        let mut gone: Vec<(NodeId, NodeId, String)> = Vec::new();
        let mut left: Vec<(NodeId, NodeId)> = Vec::new();
        let mut made: HashMap<String, (NodeId, NodeId)> = HashMap::new();
        let mut nets: BTreeSet<String> = BTreeSet::new();
        for ((doc, map, key), v) in &last {
            if let Some(net) = doc.strip_prefix("net/") {
                nets.insert(net.to_owned());
                continue;
            }
            let before = self.docs.get(doc).and_then(|d| read(d, map, key));
            match (map.as_str(), v) {
                ("edge", Some(v)) => {
                    if let Some(e) = ends_of(v) {
                        made.insert(key.clone(), e);
                    }
                }
                ("edge", None) => {
                    if let Some((a, b)) = before.as_ref().and_then(ends_of) {
                        gone.push((a, b, key.clone()));
                    }
                }
                ("placement", None) if before.is_some() => {
                    if let Some((net, node)) = key.split_once('/')
                        && let (Ok(net), Ok(node)) = (NodeId::parse(net), NodeId::parse(node))
                    {
                        left.push((net, node));
                    }
                }
                _ => {}
            }
        }
        if gone.is_empty() && left.is_empty() && nets.is_empty() {
            return Ok(());
        }
        let mut routes: HashMap<String, BTreeMap<String, Vec<String>>> = HashMap::new();
        let mut extra: Writes = Vec::new();
        // A wire that goes: its route wherever both its ends lie.
        if !gone.is_empty() {
            let index = self.placements_index();
            let nets_of = |n: &NodeId| -> HashSet<NodeId> {
                index
                    .get(n)
                    .map(|l| l.iter().map(|&(net, _)| net).collect())
                    .unwrap_or_default()
            };
            for (a, b, edge) in &gone {
                let both: BTreeSet<String> = nets_of(a)
                    .intersection(&nets_of(b))
                    .map(NodeId::to_text)
                    .collect();
                for net in both {
                    let r = self.routes_after(&net, &last, &mut routes)?;
                    if r.remove(edge).is_some() {
                        extra.push((format!("net/{net}"), "route".to_owned(), edge.clone(), None));
                        nets.insert(net);
                    }
                }
            }
        }
        // A node that leaves a network: its wires are not seen there now.
        for (net, node) in &left {
            let net = net.to_text();
            let keys: Vec<String> = self
                .routes_after(&net, &last, &mut routes)?
                .keys()
                .cloned()
                .collect();
            for edge in keys {
                let ends = made.get(&edge).copied().or_else(|| self.edge_ends(&edge));
                if ends.is_some_and(|(f, t)| f == *node || t == *node) {
                    if let Some(r) = routes.get_mut(&net) {
                        r.remove(&edge);
                    }
                    extra.push((format!("net/{net}"), "route".to_owned(), edge, None));
                    nets.insert(net.clone());
                }
            }
        }
        // An unpinned dot no route names goes; a pinned one stays (06 §6.6).
        for net in &nets {
            let named: HashSet<String> = self
                .routes_after(net, &last, &mut routes)?
                .values()
                .flatten()
                .cloned()
                .collect();
            let doc = format!("net/{net}");
            let mut dots = self.dots_in(&doc);
            for ((d, map, key), v) in &last {
                if *d != doc || map != "dot" {
                    continue;
                }
                match v.as_ref().and_then(dot_of) {
                    Some(p) => dots.insert(key.clone(), p),
                    None => dots.remove(key),
                };
            }
            for (id, (_, _, pinned)) in dots {
                if !pinned && !named.contains(&id) {
                    extra.push((doc.clone(), "dot".to_owned(), id, None));
                }
            }
        }
        plan.extend(extra);
        Ok(())
    }

    /// The routes of network `net` after the step's writes `last`, read once
    /// into `cache` (its document loaded on first use).
    fn routes_after<'c>(
        &mut self,
        net: &str,
        last: &Last,
        cache: &'c mut HashMap<String, BTreeMap<String, Vec<String>>>,
    ) -> Result<&'c mut BTreeMap<String, Vec<String>>> {
        if !cache.contains_key(net) {
            let doc = format!("net/{net}");
            self.ensure_doc(&doc)?;
            let mut r = self.routes_in(&doc);
            for ((d, map, key), v) in last {
                if *d != doc || map != "route" {
                    continue;
                }
                let dots = v.as_ref().map(route_of).unwrap_or_default();
                if dots.is_empty() {
                    r.remove(key);
                } else {
                    r.insert(key.clone(), dots);
                }
            }
            cache.insert(net.to_owned(), r);
        }
        Ok(cache.get_mut(net).expect("just put"))
    }

    /// What the canvas of network document `doc` shows of its dots (05 §9.2):
    /// each shown wire's route, by key, through the dots that are, and the
    /// dots a shown wire goes through or that are pinned.
    pub(super) fn view_dots(
        &self,
        doc: &str,
        shown: &HashSet<&str>,
    ) -> (HashMap<String, Vec<String>>, Vec<ViewDot>) {
        let dots = self.dots_in(doc);
        let mut routes = HashMap::new();
        let mut named: HashSet<String> = HashSet::new();
        for (edge, through) in self.routes_in(doc) {
            if !shown.contains(edge.as_str()) {
                continue;
            }
            let through: Vec<String> = through
                .into_iter()
                .filter(|d| dots.contains_key(d))
                .collect();
            named.extend(through.iter().cloned());
            if !through.is_empty() {
                routes.insert(edge, through);
            }
        }
        let view = dots
            .into_iter()
            .filter(|(id, (_, _, pinned))| *pinned || named.contains(id))
            .map(|(id, (x, y, pinned))| ViewDot { id, x, y, pinned })
            .collect();
        (routes, view)
    }
}
