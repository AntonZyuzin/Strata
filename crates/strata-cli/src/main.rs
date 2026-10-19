//! `strata` — one binary for the server, the headless core, the MCP launcher
//! and diagnostics (15 §2.2). Subcommands arrive with their roadmap stages.

use clap::{Parser, Subcommand};
use strata_model::NodeId;

#[derive(Debug, Parser)]
#[command(
    name = "strata",
    version,
    about = "Strata — node-based notes and projects"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print build information.
    Info,
    /// Generate a new node id (UUIDv7, Crockford base32).
    NewId,
    /// Convert an id between its UUID and base32 forms.
    Id {
        /// Id as 26 base32 characters or a UUID.
        value: String,
    },
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Info) {
        Command::Info => println!("{}", strata_core::build_info()),
        Command::NewId => println!("{}", NodeId::new()),
        Command::Id { value } => match NodeId::parse(&value) {
            Ok(id) => {
                let uuid = uuid_text(id.as_bytes());
                println!("base32: {id}\nuuid:   {uuid}");
            }
            Err(e) => {
                eprintln!("error: {e}");
                return std::process::ExitCode::FAILURE;
            }
        },
    }
    std::process::ExitCode::SUCCESS
}

fn uuid_text(b: &[u8; 16]) -> String {
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}
