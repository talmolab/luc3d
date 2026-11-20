//! Argument validation for `run_python_command`.
//!
//! `run_python_command` only allowlists the PROGRAM name, but any script in
//! the page (including scripts loaded from a CDN) can call it. So the
//! arguments are checked here too: a program may only be started with an
//! exact, known shape of arguments, and every path in them must pass the
//! caller's `PathPolicy` (the real one checks the user's folder grants).
//!
//! Everything here is pure (no I/O of its own) and compiled in every build,
//! so its tests run with and without the `sleap-nn` feature.
//!
//! Layout: one `Spec` per sleap-nn subcommand, listed in `SUBCOMMANDS`.
//! Adding Training later means writing a `TRAIN_SPEC` and one table line.
#![cfg_attr(not(feature = "sleap-nn"), allow(dead_code))]

/// Prefix of every refusal.
pub const ARGS_NOT_ALLOWED: &str = "ARGS_NOT_ALLOWED: ";

/// How the app decides whether a path may be used. Each method returns the
/// path to actually pass to the program (usually the resolved one).
pub trait PathPolicy {
    /// A file to read (the video / labels file to run on).
    fn readable_file(&self, raw: &str) -> Result<String, String>;
    /// A trained model: a folder from a read-only model grant.
    fn model_path(&self, raw: &str) -> Result<String, String>;
    /// A file to create (the predictions output).
    fn writable_output(&self, raw: &str) -> Result<String, String>;
}

/// What a flag's value must look like.
#[derive(Clone, Copy)]
enum Kind {
    /// No value: the flag alone.
    Switch,
    DataPath,
    ModelPath,
    /// Must end in `.slp`.
    OutputPath,
    /// Non-negative integer, at most 9 digits.
    Int,
    /// Finite decimal such as `0.2`, `1`, `1e-3`.
    Float,
    Enum(&'static [&'static str]),
    /// `auto|cpu|cuda|mps` or `cuda:N`.
    Device,
    /// `0-99,200,300-310`.
    Frames,
    /// `0,3,5`.
    IntList,
}

struct Flag {
    name: &'static str,
    kind: Kind,
    /// How many times it may appear.
    max: usize,
    /// Must appear at least once.
    required: bool,
}

struct Spec {
    flags: &'static [Flag],
}

const MAX_ARGV: usize = 512;
const MAX_FRAMES_LEN: usize = 1 << 20;

const fn sw(name: &'static str) -> Flag {
    Flag {
        name,
        kind: Kind::Switch,
        max: 1,
        required: false,
    }
}
const fn opt(name: &'static str, kind: Kind) -> Flag {
    Flag {
        name,
        kind,
        max: 1,
        required: false,
    }
}
const fn req(name: &'static str, kind: Kind) -> Flag {
    Flag {
        name,
        kind,
        max: 1,
        required: true,
    }
}

/// `predict` and its legacy alias `track` (sleap-nn 0.3.5).
static INFERENCE_SPEC: Spec = Spec {
    flags: &[
        sw("--gui"),
        sw("--tracking"),
        sw("--only_labeled_frames"),
        sw("--only_suggested_frames"),
        sw("--only_predicted_frames"),
        sw("--exclude_user_labeled"),
        sw("--ensure_rgb"),
        sw("--ensure_grayscale"),
        sw("--use_flow"),
        sw("--use_kalman"),
        sw("--post_connect_single_breaks"),
        sw("--filter_overlapping"),
        req("--data_path", Kind::DataPath),
        // Zero allowed: a track-only run passes no model.
        Flag {
            name: "--model_paths",
            kind: Kind::ModelPath,
            max: 4,
            required: false,
        },
        req("--output_path", Kind::OutputPath),
        opt("--video_index", Kind::Int),
        opt("--batch_size", Kind::Int),
        opt("--max_instances", Kind::Int),
        opt("--integral_patch_size", Kind::Int),
        opt("--n_points", Kind::Int),
        opt("--tracking_window_size", Kind::Int),
        opt("--max_tracks", Kind::Int),
        opt("--min_match_points", Kind::Int),
        opt("--min_new_track_points", Kind::Int),
        opt("--of_window_size", Kind::Int),
        opt("--of_max_levels", Kind::Int),
        opt("--kf_init_frame_count", Kind::Int),
        opt("--kf_reset_gap_size", Kind::Int),
        opt("--tracking_target_instance_count", Kind::Int),
        opt("--tracking_pre_cull_to_target", Kind::Int),
        opt("--tracking_clean_instance_count", Kind::Int),
        opt("--filter_min_visible_nodes", Kind::Int),
        opt("--peak_threshold", Kind::Float),
        opt("--max_edge_length_ratio", Kind::Float),
        opt("--dist_penalty_weight", Kind::Float),
        opt("--min_line_scores", Kind::Float),
        opt("--of_img_scale", Kind::Float),
        opt("--robust_best_instance", Kind::Float),
        opt("--tracking_pre_cull_iou_threshold", Kind::Float),
        opt("--tracking_clean_iou_threshold", Kind::Float),
        opt("--filter_overlapping_threshold", Kind::Float),
        opt("--filter_min_visible_node_fraction", Kind::Float),
        opt("--filter_min_mean_node_score", Kind::Float),
        opt("--filter_min_instance_score", Kind::Float),
        opt("--filter_min_centroid_distance", Kind::Float),
        opt("--device", Kind::Device),
        opt("--runtime", Kind::Enum(&["auto", "onnx", "tensorrt"])),
        opt("--integral_refinement", Kind::Enum(&["integral"])),
        opt("--features", Kind::Enum(&["centroids", "keypoints"])),
        opt(
            "--scoring_method",
            Kind::Enum(&["oks", "iou", "centroids", "euclidean_dist"]),
        ),
        opt(
            "--track_matching_method",
            Kind::Enum(&["hungarian", "greedy"]),
        ),
        opt(
            "--scoring_reduction",
            Kind::Enum(&["mean", "max", "robust_quantile"]),
        ),
        opt(
            "--kf_track_features",
            Kind::Enum(&["centroid", "keypoints"]),
        ),
        opt("--filter_overlapping_method", Kind::Enum(&["iou", "oks"])),
        opt("--frames", Kind::Frames),
        opt("--kf_node_indices", Kind::IntList),
    ],
};

/// sleap-nn subcommand -> its argument spec. Add `train` here later.
static SUBCOMMANDS: &[(&str, &Spec)] = &[("predict", &INFERENCE_SPEC), ("track", &INFERENCE_SPEC)];

fn refuse<T>(why: impl std::fmt::Display) -> Result<T, String> {
    Err(format!("{ARGS_NOT_ALLOWED}{why}"))
}

/// Check `args` for the logical program (`"uv"`, `"sleap-nn"` or
/// `"sleap-nn-python"`) and return the argv to spawn: the same tokens, with
/// each path replaced by what the policy returned.
pub fn validate_invocation(
    program: &str,
    args: &[String],
    paths: &dyn PathPolicy,
) -> Result<Vec<String>, String> {
    if args.len() > MAX_ARGV {
        return refuse(format!("too many arguments ({})", args.len()));
    }
    let strs: Vec<&str> = args.iter().map(String::as_str).collect();
    match program {
        "uv" => match strs.as_slice() {
            ["--version"] | ["tool", "list"] | ["tool", "dir"] => Ok(args.to_vec()),
            _ => refuse("uv only allows --version, tool list, tool dir"),
        },
        "sleap-nn-python" => refuse("sleap-nn-python takes no arguments from the page"),
        "sleap-nn" => {
            if strs.as_slice() == ["--version"] {
                return Ok(args.to_vec());
            }
            let Some((sub, rest)) = args.split_first() else {
                return refuse("missing sleap-nn subcommand");
            };
            let Some((_, spec)) = SUBCOMMANDS.iter().find(|(name, _)| name == sub) else {
                return refuse(format!("subcommand {sub:?} is not allowed"));
            };
            let mut out = vec![sub.clone()];
            out.extend(validate_flags(spec, rest, paths)?);
            Ok(out)
        }
        other => refuse(format!("unknown program {other:?}")),
    }
}

fn validate_flags(
    spec: &Spec,
    rest: &[String],
    paths: &dyn PathPolicy,
) -> Result<Vec<String>, String> {
    let mut counts = vec![0usize; spec.flags.len()];
    let mut out = Vec::with_capacity(rest.len());
    let mut i = 0;
    while i < rest.len() {
        let tok = &rest[i];
        if tok.starts_with("--") && tok.contains('=') {
            return refuse(format!("{tok:?}: use `--flag value`, not `--flag=value`"));
        }
        let Some(idx) = spec.flags.iter().position(|f| f.name == tok) else {
            return refuse(format!("unknown flag {tok:?}"));
        };
        let flag = &spec.flags[idx];
        counts[idx] += 1;
        if counts[idx] > flag.max {
            return refuse(format!("{tok} given more than {} time(s)", flag.max));
        }
        out.push(tok.clone());
        i += 1;
        if matches!(flag.kind, Kind::Switch) {
            continue;
        }
        let Some(value) = rest.get(i) else {
            return refuse(format!("{tok} needs a value"));
        };
        if value.starts_with("--") {
            return refuse(format!("{tok}: value {value:?} looks like a flag"));
        }
        out.push(check_value(flag, value, paths)?);
        i += 1;
    }
    for (flag, n) in spec.flags.iter().zip(&counts) {
        if flag.required && *n == 0 {
            return refuse(format!("{} is required", flag.name));
        }
    }
    Ok(out)
}

fn check_value(flag: &Flag, v: &str, paths: &dyn PathPolicy) -> Result<String, String> {
    let name = flag.name;
    let bad = |what: &str| refuse(format!("{name}: {v:?} is not {what}"));
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    match flag.kind {
        Kind::Switch => unreachable!("switches take no value"),
        Kind::DataPath => {
            if v.contains("://") {
                return bad("a local file");
            }
            paths
                .readable_file(v)
                .or_else(|e| refuse(format!("{name}: {e}")))
        }
        Kind::ModelPath => paths
            .model_path(v)
            .or_else(|e| refuse(format!("{name}: {e}"))),
        Kind::OutputPath => {
            if !v.ends_with(".slp") {
                return bad("a .slp file");
            }
            let p = paths
                .writable_output(v)
                .or_else(|e| refuse(format!("{name}: {e}")))?;
            if !p.ends_with(".slp") {
                return bad("a .slp file");
            }
            Ok(p)
        }
        Kind::Int => {
            if digits(v) && v.len() <= 9 {
                Ok(v.to_string())
            } else {
                bad("a non-negative integer")
            }
        }
        Kind::Float => {
            let charset = v
                .bytes()
                .all(|b| b.is_ascii_digit() || b"._eE+-".contains(&b));
            let finite = v.parse::<f64>().is_ok_and(f64::is_finite);
            if v.len() <= 32 && !v.starts_with('-') && charset && finite {
                Ok(v.to_string())
            } else {
                bad("a finite number")
            }
        }
        Kind::Enum(allowed) => {
            if allowed.contains(&v) {
                Ok(v.to_string())
            } else {
                bad(&format!("one of {allowed:?}"))
            }
        }
        Kind::Device => {
            let ok = ["auto", "cpu", "cuda", "mps"].contains(&v)
                || v.strip_prefix("cuda:")
                    .is_some_and(|n| digits(n) && n.len() <= 4);
            if ok {
                Ok(v.to_string())
            } else {
                bad("a device (auto, cpu, cuda, cuda:N, mps)")
            }
        }
        Kind::Frames => {
            let ok = v.len() <= MAX_FRAMES_LEN
                && v.split(',').all(|part| {
                    let mut it = part.split('-');
                    let a = it.next().is_some_and(digits);
                    let b = it.next().is_none_or(digits);
                    a && b && it.next().is_none()
                });
            if ok {
                Ok(v.to_string())
            } else {
                bad("a frame list like 0-99,200")
            }
        }
        Kind::IntList => {
            if v.len() <= 4096 && v.split(',').all(digits) {
                Ok(v.to_string())
            } else {
                bad("a list like 0,3,5")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Models live under /m/, data under /v/, outputs under /out/.
    struct Fake;
    impl PathPolicy for Fake {
        fn readable_file(&self, raw: &str) -> Result<String, String> {
            raw.starts_with("/v/")
                .then(|| format!("R:{raw}"))
                .ok_or_else(|| format!("NOT_GRANTED: {raw}"))
        }
        fn model_path(&self, raw: &str) -> Result<String, String> {
            raw.starts_with("/m/")
                .then(|| format!("M:{raw}"))
                .ok_or_else(|| format!("NOT_GRANTED: {raw}"))
        }
        fn writable_output(&self, raw: &str) -> Result<String, String> {
            raw.starts_with("/out/")
                .then(|| format!("W:{raw}"))
                .ok_or_else(|| format!("NOT_GRANTED: {raw}"))
        }
    }

    fn v(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }
    fn run(program: &str, s: &str) -> Result<Vec<String>, String> {
        validate_invocation(program, &v(s), &Fake)
    }
    fn refused(program: &str, s: &str) {
        let e = run(program, s).expect_err(s);
        assert!(e.starts_with(ARGS_NOT_ALLOWED), "{s}: {e}");
    }
    const BASE: &str = "predict --data_path /v/a.mp4 --output_path /out/a.slp";

    #[test]
    fn realistic_predict_passes_and_paths_come_from_the_policy() {
        let line = "predict --gui --data_path /v/cam1.mp4 --model_paths /m/centroid \
            --model_paths /m/ci --output_path /out/cam1.predictions.slp --frames 0-99 \
            --batch_size 4 --device auto --peak_threshold 0.2 --integral_refinement integral \
            --integral_patch_size 5 --tracking --scoring_method oks \
            --track_matching_method hungarian --tracking_window_size 5 \
            --robust_best_instance 0.95 --min_match_points 0 --min_new_track_points 0 \
            --scoring_reduction mean";
        let out = run("sleap-nn", line).unwrap();
        assert_eq!(out.len(), v(line).len());
        assert!(out.contains(&"R:/v/cam1.mp4".to_string()));
        assert!(out.contains(&"M:/m/centroid".to_string()));
        assert!(out.contains(&"M:/m/ci".to_string()));
        assert!(out.contains(&"W:/out/cam1.predictions.slp".to_string()));
        // Legacy name, track-only run (no model).
        assert!(run(
            "sleap-nn",
            "track --data_path /v/a.slp --output_path /out/a.slp --tracking"
        )
        .is_ok());
    }

    #[test]
    fn version_probes() {
        assert!(run("sleap-nn", "--version").is_ok());
        assert!(run("uv", "--version").is_ok());
        assert!(run("uv", "tool list").is_ok());
        assert!(run("uv", "tool dir").is_ok());
    }

    #[test]
    fn unknown_flags_and_equals_form_are_refused() {
        for extra in [
            "--overlay_path x",
            "--headers {}",
            "--stream-to-file x",
            "--batch_size=4",
        ] {
            refused("sleap-nn", &format!("{BASE} {extra}"));
        }
        refused("sleap-nn", &format!("{BASE} positional"));
    }

    #[test]
    fn required_duplicate_and_output_rules() {
        refused("sleap-nn", "predict --data_path /v/a.mp4");
        refused("sleap-nn", "predict --output_path /out/a.slp");
        refused("sleap-nn", &format!("{BASE} --data_path /v/b.mp4"));
        refused("sleap-nn", &format!("{BASE} --batch_size 1 --batch_size 2"));
        refused(
            "sleap-nn",
            "predict --data_path /v/a.mp4 --output_path /out/a.txt",
        );
        refused(
            "sleap-nn",
            "predict --data_path https://x/y.mp4 --output_path /out/a.slp",
        );
        refused(
            "sleap-nn",
            "predict --data_path /v/a.mp4 --output_path /elsewhere/a.slp",
        );
        refused("sleap-nn", &format!("{BASE} --model_paths /home/x/model"));
        let five = "--model_paths /m/a ".repeat(5);
        refused("sleap-nn", &format!("{BASE} {five}"));
        assert!(run(
            "sleap-nn",
            &format!("{BASE} {}", "--model_paths /m/a ".repeat(4))
        )
        .is_ok());
    }

    #[test]
    fn values_are_checked() {
        refused("sleap-nn", &format!("{BASE} --batch_size --gui"));
        refused("sleap-nn", &format!("{BASE} --batch_size"));
        for bad in ["-1", "4x", "1234567890", "1.5"] {
            refused("sleap-nn", &format!("{BASE} --batch_size {bad}"));
        }
        for bad in ["nan", "inf", "-0.2", "1e999", "0.2.3", "0x1"] {
            refused("sleap-nn", &format!("{BASE} --peak_threshold {bad}"));
        }
        for ok in ["0.2", "1", "1e-3", ".5"] {
            assert!(
                run("sleap-nn", &format!("{BASE} --peak_threshold {ok}")).is_ok(),
                "{ok}"
            );
        }
        refused("sleap-nn", &format!("{BASE} --device gpu"));
        refused("sleap-nn", &format!("{BASE} --device cuda:x"));
        assert!(run("sleap-nn", &format!("{BASE} --device cuda:1")).is_ok());
        refused("sleap-nn", &format!("{BASE} --scoring_method nope"));
        for bad in ["1;rm", "1-", "-1", "1,,2", "1-2-3", ""] {
            let args = vec![
                "predict",
                "--data_path",
                "/v/a.mp4",
                "--output_path",
                "/out/a.slp",
                "--frames",
                bad,
            ];
            let a: Vec<String> = args.into_iter().map(String::from).collect();
            assert!(
                validate_invocation("sleap-nn", &a, &Fake).is_err(),
                "{bad:?}"
            );
        }
        assert!(run("sleap-nn", &format!("{BASE} --frames 0-99,200,300-310")).is_ok());
        assert!(run("sleap-nn", &format!("{BASE} --kf_node_indices 0,3,5")).is_ok());
        refused("sleap-nn", &format!("{BASE} --kf_node_indices 0,x"));
    }

    #[test]
    fn other_subcommands_and_programs_are_refused() {
        for sub in ["train", "export", "system", "--help"] {
            refused("sleap-nn", &format!("{sub} {BASE}"));
        }
        refused("sleap-nn", "");
        refused("uv", "tool install sleap-nn");
        refused("uv", "run x");
        refused("uv", "tool list extra");
        refused("sleap-nn-python", "");
        refused("sleap-nn-python", "-c print(1)");
        refused("sleap-nn-python", "--version");
        refused("sh", "-c x");
    }

    #[test]
    fn argv_length_is_capped() {
        let many = vec!["--gui".to_string(); MAX_ARGV + 1];
        assert!(validate_invocation("sleap-nn", &many, &Fake).is_err());
    }
}
