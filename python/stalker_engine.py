import sys, os, json, time, random, requests

session = sys.argv[1]
portal = sys.argv[2].rstrip("/")
mac = sys.argv[3]
timezone = sys.argv[4]

CACHE_DIR = "cache"
os.makedirs(CACHE_DIR, exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 5 rev: 1812 Safari/533.3",
    "Referer": f"{portal}/",
    "Accept": "*/*",
    "X-User-Agent": "Model: MAG544; Link: Ethernet",
    "Cookie": f"mac={mac}; stb_lang=en; timezone={timezone}"
}

def cache(name, ttl):
    path = f"{CACHE_DIR}/{session}_{name}"
    if os.path.exists(path):
        if time.time() - os.path.getmtime(path) < ttl:
            return open(path).read()
    return None

def save(name, data):
    with open(f"{CACHE_DIR}/{session}_{name}", "w") as f:
        f.write(data)

def delay():
    time.sleep(random.uniform(0.6, 1.3))

def handshake():
    delay()
    r = requests.get(
        f"{portal}/portal.php?type=stb&action=handshake&JsHttpRequest=1-xml",
        headers={**HEADERS}
    )
    print("Handshake status:", r.status_code)
    print("Handshake raw:", r.text[:500])
    return r.json()["js"]["token"]

def get_profile(token):
    delay()
    params = {
        'type': 'stb',
        'action': 'get_profile',
        'hd': '1',
        'ver': 'ImageDescription: 0.2.18-r14-pub-250; ImageDate: Fri Jan 15 15:20:44 EET 2016; PORTAL version: 5.6.6; API Version: JS API version: 328; STB API version: 134; Player Engine version: 0x566',
        'num_banks': '2',
        'sn': '022017J023063',
        'stb_type': 'MAG544',
        'image_version': '218',
        'video_out': 'hdmi',
        'device_id': '',
        'device_id2': '',
        'signature': '',
        'auth_second_step': '1',
        'hw_version': '1.7-BD-00',
        'not_valid_token': '0',
        'JsHttpRequest': '1-xml'
    }
    headers = {**HEADERS, "Authorization": f"Bearer {token}"}
    r = requests.get(f"{portal}/portal.php", params=params, headers=headers, timeout=10)
    print("GET_PROFILE status:", r.status_code)
    print("GET_PROFILE raw (first 1000):", r.text[:1000])
    try:
        return r.json()["js"]
    except:
        print("GET_PROFILE erro:", r.text)
        return {}

def get_channels(token):
    channels = []
    page = 1
    while True:
        delay()
        url = f"{portal}/portal.php?type=itv&action=get_ordered_list&genre=0&p={page}&JsHttpRequest=1-xml"
        r = requests.get(
            url,
            headers={**HEADERS, "Authorization": f"Bearer {token}"}
        )
        print(f"GET_CHANNELS page {page} - Status: {r.status_code}")
        print(f"GET_CHANNELS page {page} - Raw (first 500): {r.text[:500]}")

        try:
            data = r.json()["js"]
            current_channels = data.get("data", [])
            if not current_channels:
                break  # sem mais canais
            channels.extend(current_channels)
            print(f"Adicionados {len(current_channels)} canais da página {page} (total acumulado: {len(channels)})")

            if len(current_channels) < data.get("max_page_items", 14):
                break  # última página
            page += 1
        except Exception as e:
            print(f"Erro na página {page}: {str(e)}")
            print(f"Raw full: {r.text}")
            break

    return channels

token = cache("token", 3600)
if not token:
    token = handshake()
    save("token", token)

print("Abrindo perfil...")
profile = get_profile(token)

channels_json = cache("channels", 21600)
if not channels_json:
    channels = get_channels(token)
    channels_json = json.dumps(channels)
    save("channels", channels_json)
else:
    channels = json.loads(channels_json)

m3u = cache("m3u.m3u", 21600)
if not m3u:
    lines = ["#EXTM3U"]
    for ch in channels:
        lines.append(f'#EXTINF:-1,{ch["name"]}')
        lines.append(ch["cmd"])
    m3u = "\n".join(lines)
    save("m3u.m3u", m3u)

print("M3U gerado em:", f"{CACHE_DIR}/{session}_m3u.m3u")
