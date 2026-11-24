//! The training config check (Training panel, local backend).
//!
//! The page sends a training config as JSON (a preset or a `training_config.yaml` it parsed and
//! edited). Any script in the page can call the training commands, and sleap-nn acts on what the
//! config names (it `torch.load`s checkpoints, writes caches and run folders, may download weights
//! or log to W&B), so Rust checks EVERY leaf key against `train_config_keys.json` (generated from
//! sleap-nn's own attrs classes by `scripts/gen_train_config_keys.py`) and refuses the rest:
//!   - an unknown key is refused, not passed through (Hydra compose would accept it silently);
//!   - each value must be of its kind (bool / int / float / str / list / dict / any), finite, with
//!     no `${` anywhere (OmegaConf interpolation, e.g. `${oc.env:SECRET}`), and within bounds for
//!     the resource keys;
//!   - the keys Rust owns are then OVERWRITTEN ([`Forced`]): the labels files, cache folder,
//!     checkpoint folder and run name, resume / pretrained checkpoints (model-grant paths or none),
//!     its ZMQ ports, W&B off, one device, `save_ckpt` on.
//!
//! The YAML Rust writes is JSON-shaped (flow style), with every float spelled so YAML 1.1 readers
//! (PyYAML, behind OmegaConf) read a float back.
#![cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// Prefix of every refusal.
pub const CONFIG_NOT_ALLOWED: &str = "CONFIG_NOT_ALLOWED: ";

const MAX_DEPTH: usize = 12;
const MAX_LIST: usize = 4096;
const MAX_STR: usize = 4096;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Bool,
    Int,
    Float,
    Str,
    List,
    Dict,
    Any,
}

pub struct KeyTable {
    keys: HashMap<String, Kind>,
    sections: HashSet<String>,
    forced: HashSet<String>,
    dropped: Vec<String>,
}

fn refuse<T>(why: impl std::fmt::Display) -> Result<T, String> {
    Err(format!("{CONFIG_NOT_ALLOWED}{why}"))
}

/// The table compiled into this build.
pub fn table() -> &'static KeyTable {
    static T: OnceLock<KeyTable> = OnceLock::new();
    T.get_or_init(|| parse_table(include_str!("train_config_keys.json")).expect("train_config_keys.json"))
}

pub fn parse_table(text: &str) -> Result<KeyTable, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut keys = HashMap::new();
    for (k, kind) in v["keys"].as_object().ok_or("no keys")? {
        let kind = match kind.as_str().unwrap_or("") {
            "bool" => Kind::Bool,
            "int" => Kind::Int,
            "float" => Kind::Float,
            "str" => Kind::Str,
            "list" => Kind::List,
            "dict" => Kind::Dict,
            _ => Kind::Any,
        };
        keys.insert(k.clone(), kind);
    }
    let sections = v["sections"].as_array().ok_or("no sections")?.iter().filter_map(|s| s.as_str().map(String::from)).collect();
    let forced = v["forced"].as_object().ok_or("no forced")?.keys().cloned().collect();
    let dropped = v["dropped_prefixes"].as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default();
    Ok(KeyTable { keys, sections, forced, dropped })
}

impl KeyTable {
    fn is_dropped(&self, path: &str) -> bool {
        self.dropped.iter().any(|p| path.starts_with(p.as_str()) || format!("{path}.") == *p)
    }
    #[cfg(test)]
    pub fn key_count(&self) -> usize {
        self.keys.len()
    }
}

/// No `${` in any string, key or value, at any depth; bounded size and depth.
fn check_strings(v: &Value, path: &str, depth: usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return refuse(format!("{path}: nested too deep"));
    }
    match v {
        Value::String(s) => {
            if s.len() > MAX_STR {
                return refuse(format!("{path}: text too long"));
            }
            if s.contains("${") {
                return refuse(format!("{path}: \"${{\" (a config variable) is not allowed"));
            }
            Ok(())
        }
        Value::Number(n) => {
            if n.as_f64().is_some_and(|f| f.is_finite()) {
                Ok(())
            } else {
                refuse(format!("{path}: not a finite number"))
            }
        }
        Value::Array(a) => {
            if a.len() > MAX_LIST {
                return refuse(format!("{path}: list too long"));
            }
            a.iter().enumerate().try_for_each(|(i, x)| check_strings(x, &format!("{path}[{i}]"), depth + 1))
        }
        Value::Object(o) => {
            if o.len() > MAX_LIST {
                return refuse(format!("{path}: too many keys"));
            }
            for (k, x) in o {
                if k.contains("${") {
                    return refuse(format!("{path}: key {k:?} is not allowed"));
                }
                check_strings(x, &format!("{path}.{k}"), depth + 1)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_kind(kind: Kind, v: &Value, path: &str) -> Result<(), String> {
    if v.is_null() {
        return Ok(());
    }
    let ok = match kind {
        Kind::Bool => v.is_boolean(),
        Kind::Int => v.as_i64().is_some() || v.as_u64().is_some(),
        Kind::Float => v.is_number(),
        Kind::Str => v.is_string(),
        Kind::List => v.is_array(),
        Kind::Dict => v.is_object(),
        Kind::Any => true,
    };
    if !ok {
        return refuse(format!("{path}: expected {kind:?}"));
    }
    check_strings(v, path, 0)
}

/// Resource and safety bounds on specific keys (checked after the kind).
fn check_bounds(path: &str, v: &Value, cpus: u64) -> Result<(), String> {
    let int = |lo: i64, hi: i64| -> Result<(), String> {
        match v.as_i64() {
            None if v.is_null() => Ok(()),
            Some(n) if (lo..=hi).contains(&n) => Ok(()),
            _ => refuse(format!("{path}: must be a whole number from {lo} to {hi}")),
        }
    };
    match path {
        "trainer_config.max_epochs" => int(1, 10_000),
        "trainer_config.train_data_loader.batch_size" | "trainer_config.val_data_loader.batch_size" => int(1, 512),
        "trainer_config.train_data_loader.num_workers" | "trainer_config.val_data_loader.num_workers" => {
            if v.is_string() {
                refuse(format!("{path}: must be a number"))
            } else {
                int(0, cpus as i64)
            }
        }
        "data_config.data_pipeline_fw" => match v.as_str() {
            None if v.is_null() => Ok(()),
            Some("torch_dataset" | "torch_dataset_cache_img_memory" | "torch_dataset_cache_img_disk") => Ok(()),
            _ => refuse(format!("{path}: unknown data pipeline")),
        },
        "model_config.backbone_config.convnext.pre_trained_weights" | "model_config.backbone_config.swint.pre_trained_weights" => {
            match v.as_str() {
                None if v.is_null() => Ok(()),
                Some(s) if !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') => Ok(()),
                _ => refuse(format!("{path}: must name torchvision weights (e.g. ConvNeXt_Tiny_Weights)")),
            }
        }
        _ => Ok(()),
    }
}

/// Check a config object against `table`. Keys under a dropped prefix (W&B) are accepted and
/// removed later by [`finalize`]; forced keys may hold anything of their kind (overwritten).
pub fn check(cfg: &Value, table: &KeyTable, cpus: u64) -> Result<(), String> {
    let Some(top) = cfg.as_object() else { return refuse("the config must be an object") };
    walk(top, "", table, cpus, 0)
}

fn walk(obj: &Map<String, Value>, prefix: &str, table: &KeyTable, cpus: u64, depth: usize) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return refuse(format!("{prefix}: nested too deep"));
    }
    for (k, v) in obj {
        if k.is_empty() || k.contains('.') || k.contains("${") {
            return refuse(format!("key {k:?} is not allowed"));
        }
        let path = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        if table.is_dropped(&path) {
            check_strings(v, &path, depth)?;
            continue;
        }
        if table.sections.contains(&path) {
            match v {
                Value::Null => {}
                Value::Object(o) => walk(o, &path, table, cpus, depth + 1)?,
                _ => return refuse(format!("{path}: expected a section")),
            }
            continue;
        }
        let Some(kind) = table.keys.get(&path) else {
            return refuse(format!("unknown key {path}"));
        };
        check_kind(*kind, v, &path)?;
        check_bounds(&path, v, cpus)?;
    }
    Ok(())
}

/// What Rust writes over the page's config.
pub struct Forced<'a> {
    pub train_labels: &'a str,
    pub val_labels: Option<&'a str>,
    pub cache_dir: &'a str,
    pub ckpt_dir: &'a str,
    pub run_name: &'a str,
    pub resume_ckpt: Option<&'a str>,
    pub pretrained_backbone: Option<&'a str>,
    pub pretrained_head: Option<&'a str>,
    pub controller_port: u16,
    pub publish_port: u16,
}

fn section<'v>(root: &'v mut Map<String, Value>, path: &[&str]) -> &'v mut Map<String, Value> {
    let mut cur = root;
    for k in path {
        let e = cur.entry((*k).to_string()).or_insert_with(|| Value::Object(Map::new()));
        if !e.is_object() {
            *e = Value::Object(Map::new());
        }
        cur = e.as_object_mut().expect("object");
    }
    cur
}

fn opt(s: Option<&str>) -> Value {
    s.map(|x| Value::String(x.to_string())).unwrap_or(Value::Null)
}

/// The config sleap-nn gets: `cfg` (already [`check`]ed) with the dropped subtrees removed and
/// every forced key set. Run it on a checked config only.
pub fn finalize(cfg: &Value, f: &Forced, table: &KeyTable) -> Value {
    let mut out = cfg.clone();
    let root = out.as_object_mut().expect("checked config is an object");
    for p in &table.dropped {
        let parts: Vec<&str> = p.trim_end_matches('.').split('.').collect();
        if let Some((last, head)) = parts.split_last() {
            let s = section(root, head);
            s.remove(*last);
        }
    }
    root.insert("filename".into(), Value::String(String::new()));
    {
        let data = section(root, &["data_config"]);
        data.insert("train_labels_path".into(), Value::Array(vec![Value::String(f.train_labels.into())]));
        data.insert(
            "val_labels_path".into(),
            f.val_labels.map(|v| Value::Array(vec![Value::String(v.into())])).unwrap_or(Value::Null),
        );
        data.insert("test_file_path".into(), Value::Null);
        data.insert("cache_img_path".into(), Value::String(f.cache_dir.into()));
        data.insert("skeletons".into(), Value::Null);
    }
    {
        let model = section(root, &["model_config"]);
        model.insert("pretrained_backbone_weights".into(), opt(f.pretrained_backbone));
        model.insert("pretrained_head_weights".into(), opt(f.pretrained_head));
    }
    {
        let t = section(root, &["trainer_config"]);
        t.insert("ckpt_dir".into(), Value::String(f.ckpt_dir.into()));
        t.insert("run_name".into(), Value::String(f.run_name.into()));
        t.insert("resume_ckpt_path".into(), opt(f.resume_ckpt));
        t.insert("save_ckpt".into(), Value::Bool(true));
        t.insert("use_wandb".into(), Value::Bool(false));
        t.insert("profiler".into(), Value::Null);
        // One device: more makes sleap-nn respawn itself (a process tree Rust did not start).
        t.insert("trainer_devices".into(), Value::from(1));
        t.insert("trainer_device_indices".into(), Value::Null);
        t.insert("trainer_strategy".into(), Value::String("auto".into()));
        let z = section(t, &["zmq"]);
        z.insert("controller_port".into(), Value::from(f.controller_port));
        z.insert("publish_port".into(), Value::from(f.publish_port));
    }
    // Forced keys the table lists but this code does not know yet would stay as the page sent
    // them: refuse to build such a config (a sleap-nn bump must be looked at).
    debug_assert!(table.forced.iter().all(|k| known_forced(k)), "a forced key is not handled");
    out
}

fn known_forced(k: &str) -> bool {
    matches!(
        k,
        "data_config.train_labels_path"
            | "data_config.val_labels_path"
            | "data_config.test_file_path"
            | "data_config.cache_img_path"
            | "data_config.skeletons"
            | "trainer_config.ckpt_dir"
            | "trainer_config.run_name"
            | "trainer_config.resume_ckpt_path"
            | "model_config.pretrained_backbone_weights"
            | "model_config.pretrained_head_weights"
            | "trainer_config.zmq.controller_port"
            | "trainer_config.zmq.publish_port"
            | "trainer_config.save_ckpt"
            | "trainer_config.use_wandb"
            | "trainer_config.profiler"
            | "filename"
    )
}

/// Every forced key of the table is one [`finalize`] writes.
pub fn forced_keys_handled(table: &KeyTable) -> Result<(), String> {
    match table.forced.iter().find(|k| !known_forced(k)) {
        Some(k) => Err(format!("forced key {k} is not written by finalize")),
        None => Ok(()),
    }
}

/// A float YAML 1.1 reads as a float: always a `.`, and a signed exponent.
fn yaml_float(f: f64) -> String {
    if f == f.trunc() && f.abs() < 1e15 {
        return format!("{f:.1}");
    }
    let s = format!("{f:?}");
    match s.split_once('e') {
        None => s,
        Some((m, e)) => {
            let m = if m.contains('.') { m.to_string() } else { format!("{m}.0") };
            let e = if e.starts_with('-') || e.starts_with('+') { e.to_string() } else { format!("+{e}") };
            format!("{m}e{e}")
        }
    }
}

/// `v` as YAML (flow style; strings JSON-quoted, which YAML double-quoted scalars accept).
pub fn to_yaml(v: &Value) -> String {
    let mut out = String::new();
    emit(v, &mut out);
    out.push('\n');
    out
}

fn emit(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                out.push_str(&yaml_float(n.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                emit(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push_str(": ");
                emit(x, out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn t() -> &'static KeyTable {
        table()
    }

    fn base() -> Value {
        json!({
            "data_config": { "validation_fraction": 0.1, "augmentation_config": { "geometric": { "rotation_min": -180.0, "rotation_max": 180.0 } } },
            "model_config": { "head_configs": { "centroid": { "confmaps": { "sigma": 2.5, "anchor_part": null, "output_stride": 2 } } } },
            "trainer_config": { "max_epochs": 5, "train_data_loader": { "batch_size": 4, "num_workers": 0 },
                "wandb": { "api_key": "secret", "entity": "x" }, "use_wandb": true, "zmq": { "controller_port": 9000 } },
            "name": "", "description": "", "sleap_nn_version": "0.3.5", "filename": "x.yaml"
        })
    }

    fn forced() -> Forced<'static> {
        Forced {
            train_labels: "/tmp/s/train.slp", val_labels: Some("/tmp/s/val.slp"), cache_dir: "/tmp/s/cache", ckpt_dir: "/runs",
            run_name: "r1", resume_ckpt: None, pretrained_backbone: None, pretrained_head: None, controller_port: 50001, publish_port: 50002,
        }
    }

    #[test]
    fn the_compiled_table_is_sleap_nns() {
        assert!(t().key_count() > 300, "{}", t().key_count());
        forced_keys_handled(t()).unwrap();
        assert_eq!(t().keys.get("trainer_config.max_epochs"), Some(&Kind::Int));
        assert_eq!(t().keys.get("data_config.validation_fraction"), Some(&Kind::Float));
    }

    #[test]
    fn a_preset_shaped_config_passes() {
        check(&base(), t(), 8).unwrap();
    }

    #[test]
    fn unknown_keys_and_interpolation_are_refused() {
        let mut c = base();
        c["trainer_config"]["not_a_key"] = json!(1);
        assert!(check(&c, t(), 8).unwrap_err().contains("unknown key trainer_config.not_a_key"));
        let mut c = base();
        c["hydra"] = json!({ "run": { "dir": "/" } });
        assert!(check(&c, t(), 8).unwrap_err().contains("unknown key hydra"));
        let mut c = base();
        c["defaults"] = json!(["other"]);
        assert!(check(&c, t(), 8).unwrap_err().contains("unknown key defaults"));
        let mut c = base();
        c["name"] = json!("${oc.env:HOME}");
        assert!(check(&c, t(), 8).unwrap_err().contains("config variable"));
        let mut c = base();
        c["model_config"]["head_configs"]["centroid"]["confmaps"]["anchor_part"] = json!("a${b}");
        assert!(check(&c, t(), 8).is_err());
        let mut c = base();
        c["data_config"]["augmentation_config"]["geometric"]["${x}"] = json!(1);
        assert!(check(&c, t(), 8).is_err());
        let mut c = base();
        c["model_config"]["head_configs"]["centroid"]["confmaps"]["a.b"] = json!(1);
        assert!(check(&c, t(), 8).unwrap_err().contains("not allowed"));
    }

    #[test]
    fn kinds_and_bounds_are_checked() {
        let mut c = base();
        c["trainer_config"]["max_epochs"] = json!("five");
        assert!(check(&c, t(), 8).unwrap_err().contains("expected Int"));
        let mut c = base();
        c["trainer_config"]["max_epochs"] = json!(100_000);
        assert!(check(&c, t(), 8).unwrap_err().contains("from 1 to 10000"));
        let mut c = base();
        c["trainer_config"]["train_data_loader"]["batch_size"] = json!(4096);
        assert!(check(&c, t(), 8).is_err());
        let mut c = base();
        c["trainer_config"]["train_data_loader"]["num_workers"] = json!(64);
        assert!(check(&c, t(), 8).unwrap_err().contains("from 0 to 8"));
        let mut c = base();
        c["data_config"]["data_pipeline_fw"] = json!("os.system");
        assert!(check(&c, t(), 8).is_err());
        let mut c = base();
        c["model_config"]["backbone_config"] = json!({ "convnext": { "pre_trained_weights": "/tmp/evil.pt" } });
        assert!(check(&c, t(), 8).unwrap_err().contains("torchvision weights"));
        // serde_json cannot hold a non-finite number, so JSON from the page is always finite.
        assert!(serde_json::from_str::<Value>("1e400").is_err());
        let mut c = base();
        c["data_config"]["augmentation_config"] = json!(5);
        assert!(check(&c, t(), 8).unwrap_err().contains("expected a section"));
    }

    #[test]
    fn finalize_forces_what_rust_owns_and_drops_wandb() {
        let mut c = base();
        c["trainer_config"]["ckpt_dir"] = json!("/etc");
        c["trainer_config"]["resume_ckpt_path"] = json!("/tmp/evil.ckpt");
        c["model_config"]["pretrained_backbone_weights"] = json!("/tmp/evil.ckpt");
        c["trainer_config"]["trainer_devices"] = json!(8);
        c["data_config"]["cache_img_path"] = json!("/");
        check(&c, t(), 8).unwrap();
        let f = finalize(&c, &forced(), t());
        assert_eq!(f["trainer_config"]["ckpt_dir"], json!("/runs"));
        assert_eq!(f["trainer_config"]["run_name"], json!("r1"));
        assert_eq!(f["trainer_config"]["resume_ckpt_path"], Value::Null);
        assert_eq!(f["model_config"]["pretrained_backbone_weights"], Value::Null);
        assert_eq!(f["data_config"]["cache_img_path"], json!("/tmp/s/cache"));
        assert_eq!(f["data_config"]["train_labels_path"], json!(["/tmp/s/train.slp"]));
        assert_eq!(f["data_config"]["val_labels_path"], json!(["/tmp/s/val.slp"]));
        assert_eq!(f["trainer_config"]["zmq"], json!({ "controller_port": 50001, "publish_port": 50002 }));
        assert_eq!(f["trainer_config"]["use_wandb"], json!(false));
        assert!(f["trainer_config"].get("wandb").is_none(), "the W&B block (API key) is dropped");
        assert_eq!(f["trainer_config"]["trainer_devices"], json!(1));
        assert_eq!(f["trainer_config"]["save_ckpt"], json!(true));
        assert_eq!(f["filename"], json!(""));
        check(&f, t(), 8).unwrap();
    }

    #[test]
    fn yaml_floats_read_back_as_floats() {
        assert_eq!(yaml_float(2.0), "2.0");
        assert_eq!(yaml_float(0.0001), "0.0001");
        assert_eq!(yaml_float(1e-8), "1.0e-8");
        assert_eq!(yaml_float(1.5e21), "1.5e+21");
        assert_eq!(yaml_float(-180.0), "-180.0");
        let y = to_yaml(&json!({ "a": [1, 2.5, "x\"y"], "b": { "c": null, "d": true }, "e": 1e-8 }));
        assert_eq!(y, "{\"a\": [1, 2.5, \"x\\\"y\"], \"b\": {\"c\": null, \"d\": true}, \"e\": 1.0e-8}\n");
    }
}
