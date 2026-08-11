use std::{env, fmt::Write as _, fs, path::PathBuf};

fn required<'a>(value: &'a serde_json::Value, path: &[&str]) -> &'a serde_json::Value {
    let mut current = value;
    for segment in path {
        current = current
            .get(segment)
            .unwrap_or_else(|| panic!("missing capability contract field {}", path.join(".")));
    }
    current
}

fn string(value: &serde_json::Value, path: &[&str]) -> String {
    required(value, path)
        .as_str()
        .unwrap_or_else(|| {
            panic!(
                "capability contract field {} must be a string",
                path.join(".")
            )
        })
        .to_owned()
}

fn main() {
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let contract_path = manifest.join("../../shared/dkg-memory/capability-contract.json");
    println!("cargo:rerun-if-changed={}", contract_path.display());
    let source = fs::read_to_string(&contract_path).unwrap_or_else(|error| {
        panic!(
            "failed to read capability contract {}: {error}",
            contract_path.display()
        )
    });
    let contract: serde_json::Value = serde_json::from_str(&source).unwrap_or_else(|error| {
        panic!(
            "invalid capability contract {}: {error}",
            contract_path.display()
        )
    });

    let v1_extension = string(&contract, &["memory", "v1_extension"]);
    let v2_extension = string(&contract, &["memory", "v2_extension"]);
    let v2_schema_version = required(&contract, &["memory", "v2_schema_version"])
        .as_u64()
        .expect("memory.v2_schema_version must be an unsigned integer");
    let v2_profile = string(&contract, &["memory", "v2_profile"]);
    let semantic_operation = string(&contract, &["semantic_query", "operation"]);
    let semantic_scope = string(&contract, &["semantic_query", "scope"]);
    let required_forms = required(&contract, &["semantic_query", "required_forms"])
        .as_array()
        .expect("semantic_query.required_forms must be an array")
        .iter()
        .map(|entry| {
            entry
                .as_str()
                .expect("semantic_query.required_forms entries must be strings")
        })
        .collect::<Vec<_>>();
    assert!(
        !required_forms.is_empty(),
        "semantic_query.required_forms must not be empty"
    );

    let mut generated = String::new();
    writeln!(
        generated,
        "pub const MEMORY_V1_EXTENSION: &str = {v1_extension:?};"
    )
    .expect("write generated contract");
    writeln!(
        generated,
        "pub const MEMORY_V2_EXTENSION: &str = {v2_extension:?};"
    )
    .expect("write generated contract");
    writeln!(
        generated,
        "pub const MEMORY_V2_SCHEMA_VERSION: u64 = {v2_schema_version};"
    )
    .expect("write generated contract");
    writeln!(
        generated,
        "pub const MEMORY_V2_PROFILE: &str = {v2_profile:?};"
    )
    .expect("write generated contract");
    writeln!(
        generated,
        "pub const SEMANTIC_QUERY_OPERATION: &str = {semantic_operation:?};"
    )
    .expect("write generated contract");
    writeln!(
        generated,
        "pub const SEMANTIC_QUERY_SCOPE: &str = {semantic_scope:?};"
    )
    .expect("write generated contract");
    writeln!(
        generated,
        "pub const SEMANTIC_QUERY_REQUIRED_FORMS: &[&str] = &{:?};",
        required_forms
    )
    .expect("write generated contract");

    let output = PathBuf::from(env::var_os("OUT_DIR").expect("output directory"))
        .join("dkg_capability_contract.rs");
    fs::write(output, generated).expect("write generated capability contract");
}
