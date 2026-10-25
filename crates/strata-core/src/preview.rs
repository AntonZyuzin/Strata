//! Link previews (05 §4.4, ✅ Q-13-16, ADR-0012): the page a link asset
//! points to, read the way messengers read it — its title and its picture
//! from the Open Graph and Twitter tags of its head. The fetch is plain HTTP
//! from this machine over the system's TLS and trust store; nothing goes
//! through a third party. The result is stored by
//! [`Workspace::apply_preview`](crate::Workspace::apply_preview).
//!
//! Limits keep a page from holding the app: a whole fetch ends in 10 s, a
//! page is read up to 1 MiB (its head comes first), a picture up to 5 MiB and
//! only PNG, JPEG, GIF, WebP or AVIF by their first bytes — never SVG, which
//! may carry scripts.

use html5gum::{DefaultEmitter, Token, Tokenizer};
use std::collections::HashMap;
use std::io::Read;
use std::time::Duration;
use url::Url;

/// How much of a page is read: its head comes first.
pub const PAGE_LIMIT: u64 = 1 << 20;
/// The largest picture kept.
pub const PICTURE_LIMIT: u64 = 5 << 20;
const TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT: Duration = Duration::from_secs(5);
const REDIRECTS: u32 = 5;
/// Sites that serve their tags to link expanders only want one to say so.
const AGENT: &str = concat!(
    "Mozilla/5.0 (compatible; GexogonBot/",
    env!("CARGO_PKG_VERSION"),
    "; link preview; +https://github.com/AntonZyuzin/Strata)"
);

/// What a page's head says about it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Head {
    pub title: Option<String>,
    pub picture: Option<Url>,
}

/// A link's preview: the page's title and its picture's bytes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Preview {
    pub title: Option<String>,
    pub picture: Option<Vec<u8>>,
}

#[derive(Debug, thiserror::Error)]
pub enum PreviewError {
    #[error("not a web link: {0}")]
    NotWeb(String),
    #[error("{0}")]
    Http(#[from] ureq::Error),
    #[error("reading the page: {0}")]
    Read(#[from] std::io::Error),
}

/// Fetches the preview of `link` (http or https). A link to a picture is its
/// own preview; a page gives its title and picture; anything else, nothing.
pub fn fetch(link: &str) -> Result<Preview, PreviewError> {
    let url = Url::parse(link).map_err(|_| PreviewError::NotWeb(link.to_owned()))?;
    if !web(&url) {
        return Err(PreviewError::NotWeb(link.to_owned()));
    }
    let agent = agent();
    let mut response = agent
        .get(url.as_str())
        .header(
            "Accept",
            "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.1",
        )
        .call()?;
    // After redirects: relative links of the page are relative to where it is.
    let base = Url::parse(&ureq::ResponseExt::get_uri(&response).to_string()).unwrap_or(url);
    let body = response.body_mut();
    let mime = body.mime_type().unwrap_or("").to_ascii_lowercase();
    if mime.starts_with("image/") {
        return Ok(Preview {
            title: None,
            picture: read_picture(body.as_reader())?,
        });
    }
    if mime != "text/html" && mime != "application/xhtml+xml" {
        return Ok(Preview::default());
    }
    let charset = body.charset().map(str::to_owned);
    let mut bytes = Vec::new();
    body.as_reader().take(PAGE_LIMIT).read_to_end(&mut bytes)?;
    let head = parse_head(&decode(&bytes, charset.as_deref()), &base);
    let picture = match &head.picture {
        // A picture that cannot be had leaves the title.
        Some(src) => picture(&agent, src).unwrap_or(None),
        None => None,
    };
    Ok(Preview {
        title: head.title,
        picture,
    })
}

fn agent() -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig, TlsProvider};
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .timeout_connect(Some(CONNECT))
        .max_redirects(REDIRECTS)
        .user_agent(AGENT)
        .tls_config(
            TlsConfig::builder()
                .provider(TlsProvider::NativeTls)
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into()
}

fn web(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host().is_some()
}

fn picture(agent: &ureq::Agent, src: &Url) -> Result<Option<Vec<u8>>, PreviewError> {
    let mut response = agent
        .get(src.as_str())
        .header(
            "Accept",
            "image/avif,image/webp,image/png,image/jpeg,image/gif",
        )
        .call()?;
    let body = response.body_mut();
    if !body.mime_type().unwrap_or("").starts_with("image/") {
        return Ok(None);
    }
    read_picture(body.as_reader())
}

/// A picture's bytes when they are whole, within the limit, and a format
/// every WebView draws; none otherwise.
fn read_picture(reader: impl Read) -> Result<Option<Vec<u8>>, PreviewError> {
    let mut bytes = Vec::new();
    reader.take(PICTURE_LIMIT + 1).read_to_end(&mut bytes)?;
    Ok((bytes.len() as u64 <= PICTURE_LIMIT && drawable(&bytes)).then_some(bytes))
}

/// PNG, JPEG, GIF, WebP or AVIF by their signatures; SVG and the rest no.
fn drawable(b: &[u8]) -> bool {
    b.starts_with(b"\x89PNG\r\n\x1a\n")
        || b.starts_with(b"\xff\xd8\xff")
        || b.starts_with(b"GIF87a")
        || b.starts_with(b"GIF89a")
        || (b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP")
        || (b.len() >= 12 && &b[4..8] == b"ftyp" && matches!(&b[8..12], b"avif" | b"avis"))
}

/// The page as text: its byte order mark, else the charset of the response,
/// else the one its `<meta>` names in the first kilobyte, else UTF-8.
pub fn decode(bytes: &[u8], charset: Option<&str>) -> String {
    let named = charset
        .and_then(|c| encoding_rs::Encoding::for_label(c.trim().as_bytes()))
        .or_else(|| meta_charset(&bytes[..bytes.len().min(1024)]));
    let encoding = named.unwrap_or(encoding_rs::UTF_8);
    // `decode` lets a byte order mark win over the label, as browsers do.
    encoding.decode(bytes).0.into_owned()
}

fn meta_charset(prefix: &[u8]) -> Option<&'static encoding_rs::Encoding> {
    let text = String::from_utf8_lossy(prefix).to_ascii_lowercase();
    let at = text.find("charset=")? + "charset=".len();
    let label: String = text[at..]
        .trim_start_matches(['"', '\''])
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
        .collect();
    encoding_rs::Encoding::for_label(label.as_bytes())
}

/// The title and the picture a page's head names (Open Graph first, then
/// Twitter, then `<title>` and the touch icon), links resolved against
/// `base`. The head ends at `</head>` or the first tag of the body.
pub fn parse_head(html: &str, base: &Url) -> Head {
    let mut emitter = DefaultEmitter::default();
    // `<title>` is text up to `</title>`, `<script>` and `<style>` too.
    emitter.naively_switch_states(true);
    let mut meta: HashMap<String, String> = HashMap::new();
    let mut links: HashMap<&'static str, String> = HashMap::new();
    let mut title = String::new();
    let mut in_title = false;
    let mut titled = false;
    let text = |v: &[u8]| String::from_utf8_lossy(v).into_owned();
    for token in Tokenizer::new_with_emitter(html, emitter).flatten() {
        match token {
            Token::StartTag(tag) => {
                let attr = |name: &str| tag.attributes.get(name.as_bytes()).map(|v| text(&v.value));
                match tag.name.as_slice() {
                    b"title" if !titled => in_title = true,
                    b"meta" => {
                        let key = attr("property").or_else(|| attr("name"));
                        if let (Some(key), Some(content)) = (key, attr("content")) {
                            meta.entry(key.trim().to_ascii_lowercase())
                                .or_insert(content);
                        }
                    }
                    b"link" => {
                        let rel = attr("rel").unwrap_or_default().to_ascii_lowercase();
                        if let Some(href) = attr("href") {
                            for kind in ["image_src", "apple-touch-icon"] {
                                if rel.split_whitespace().any(|r| r == kind) {
                                    links.entry(kind).or_insert_with(|| href.clone());
                                }
                            }
                        }
                    }
                    b"body" | b"div" | b"p" | b"main" | b"article" | b"section" | b"header" => {
                        break;
                    }
                    _ => {}
                }
            }
            Token::EndTag(tag) => match tag.name.as_slice() {
                b"title" if in_title => {
                    in_title = false;
                    titled = true;
                }
                b"head" => break,
                _ => {}
            },
            Token::String(s) if in_title => title.push_str(&text(&s.value)),
            _ => {}
        }
    }
    let tidy = |s: &str| {
        let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
        (!s.is_empty()).then_some(s)
    };
    let title = ["og:title", "twitter:title"]
        .iter()
        .find_map(|k| meta.get(*k).and_then(|v| tidy(v)))
        .or_else(|| tidy(&title));
    let picture = [
        "og:image:secure_url",
        "og:image:url",
        "og:image",
        "twitter:image",
        "twitter:image:src",
    ]
    .iter()
    .filter_map(|k| meta.get(*k))
    .chain(
        ["image_src", "apple-touch-icon"]
            .iter()
            .filter_map(|k| links.get(k)),
    )
    .find_map(|src| base.join(src.trim()).ok().filter(web));
    Head { title, picture }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    fn base() -> Url {
        Url::parse("https://example.org/news/item?id=7").expect("url")
    }

    #[test]
    fn open_graph_comes_first_then_twitter_then_the_title() {
        let head = parse_head(
            r#"<!doctype html><html><head>
               <title>Сайт &amp; заголовок</title>
               <meta name="twitter:title" content="Twitter">
               <meta property="og:title" content="  Старая
                  мельница ">
               <meta name="twitter:image" content="/tw.png">
               <meta property="og:image" content="../pics/mill.jpg">
               </head><body><meta property="og:image" content="/late.png"></body>"#,
            &base(),
        );
        assert_eq!(head.title.as_deref(), Some("Старая мельница"));
        assert_eq!(
            head.picture.map(String::from).as_deref(),
            Some("https://example.org/pics/mill.jpg"),
            "relative to the page"
        );
        let plain = parse_head(
            "<html><head><title>Сайт &amp; заголовок</title><link rel=\"apple-touch-icon\" href=\"//cdn.example.org/i.png\">",
            &base(),
        );
        assert_eq!(plain.title.as_deref(), Some("Сайт & заголовок"));
        assert_eq!(
            plain.picture.map(String::from).as_deref(),
            Some("https://cdn.example.org/i.png")
        );
    }

    #[test]
    fn the_head_ends_at_the_body_and_scripts_are_not_tags() {
        let head = parse_head(
            r#"<head><script>var s = '<meta property="og:title" content="script">';</script>
               </head><body><meta property="og:title" content="body"><title>body</title>"#,
            &base(),
        );
        assert_eq!(head, Head::default());
        // A picture that is no web link is none.
        let odd = parse_head(
            r#"<meta property="og:image" content="javascript:alert(1)">"#,
            &base(),
        );
        assert_eq!(odd.picture, None);
    }

    #[test]
    fn a_page_in_another_charset_reads_as_text() {
        let (cp1251, _, _) = encoding_rs::WINDOWS_1251
            .encode("<meta charset=\"windows-1251\"><title>Мельница</title>");
        let html = decode(&cp1251, None);
        assert_eq!(
            parse_head(&html, &base()).title.as_deref(),
            Some("Мельница")
        );
        assert_eq!(decode(&cp1251, Some("windows-1251")), html);
        assert_eq!(decode("Мельница".as_bytes(), None), "Мельница");
    }

    #[test]
    fn only_whole_pictures_of_drawable_formats_are_kept() {
        assert!(drawable(PNG));
        assert!(drawable(b"\xff\xd8\xff\xe0"));
        assert!(drawable(b"RIFF\0\0\0\0WEBPVP8 "));
        assert!(!drawable(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
        assert!(!drawable(b"<!doctype html>"));
        let big = [PNG, &vec![0u8; PICTURE_LIMIT as usize]].concat();
        assert_eq!(read_picture(&big[..]).expect("read"), None);
        assert_eq!(read_picture(PNG).expect("read"), Some(PNG.to_vec()));
    }

    #[test]
    fn a_link_that_is_not_a_web_page_is_refused() {
        assert!(matches!(
            fetch("ftp://example.org/a"),
            Err(PreviewError::NotWeb(_))
        ));
        assert!(matches!(
            fetch("mailto:a@b.c"),
            Err(PreviewError::NotWeb(_))
        ));
        assert!(matches!(fetch("not a link"), Err(PreviewError::NotWeb(_))));
    }

    /// A server on this machine: each path its content type and body.
    fn serve(pages: Vec<(&'static str, &'static str, Vec<u8>)>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten().take(8) {
                let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                let mut line = String::new();
                reader.read_line(&mut line).ok();
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                // The rest of the request's head.
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).unwrap_or(0) <= 2 {
                        break;
                    }
                }
                let mut out = stream;
                match pages.iter().find(|(p, _, _)| *p == path) {
                    Some((_, mime, body)) => {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        out.write_all(head.as_bytes()).ok();
                        out.write_all(body).ok();
                    }
                    None => {
                        out.write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .ok();
                    }
                }
            }
        });
        format!("http://{addr}")
    }

    #[test]
    fn fetches_the_title_and_the_picture_of_a_page() {
        let host = serve(vec![
            (
                "/page",
                "text/html; charset=utf-8",
                r#"<html><head><meta property="og:title" content="Мельница"><meta property="og:image" content="/mill.png"></head><body>…</body></html>"#.as_bytes().to_vec(),
            ),
            ("/mill.png", "image/png", PNG.to_vec()),
            ("/pic", "image/png", PNG.to_vec()),
            (
                "/broken",
                "text/html",
                r#"<meta property="og:title" content="Без картинки"><meta property="og:image" content="/missing.png">"#.as_bytes().to_vec(),
            ),
            ("/file", "application/pdf", b"%PDF-1.7".to_vec()),
        ]);
        let page = fetch(&format!("{host}/page")).expect("page");
        assert_eq!(page.title.as_deref(), Some("Мельница"));
        assert_eq!(page.picture.as_deref(), Some(PNG));
        // A link to a picture is its own preview.
        let pic = fetch(&format!("{host}/pic")).expect("picture");
        assert_eq!(
            pic,
            Preview {
                title: None,
                picture: Some(PNG.to_vec())
            }
        );
        // A picture that is not there leaves the title.
        let broken = fetch(&format!("{host}/broken")).expect("broken");
        assert_eq!(broken.title.as_deref(), Some("Без картинки"));
        assert_eq!(broken.picture, None);
        assert_eq!(
            fetch(&format!("{host}/file")).expect("file"),
            Preview::default()
        );
        assert!(fetch(&format!("{host}/gone")).is_err(), "a 404 is an error");
    }
}
