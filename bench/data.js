window.BENCHMARK_DATA = {
  "lastUpdate": 1788716029699,
  "repoUrl": "https://github.com/polymorph-components/polymorph-stream-dom",
  "entries": {
    "Benchmark": [
      {
        "commit": {
          "author": {
            "email": "lannbot@lannbox.com",
            "name": "Lann(bot)",
            "username": "lannbot"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "1d46dbdc952bb69bb806c34bc0c7e156f7403e55",
          "message": "Merge pull request #10 from polymorph-components/bench-matrix\n\nbench: default matrix drops the chunked transport and runs 15 samples",
          "timestamp": "2026-09-06T13:05:00-04:00",
          "tree_id": "3275b00d503ef2616a6f4f2ee60c8b4f5452feda",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/1d46dbdc952bb69bb806c34bc0c7e156f7403e55"
        },
        "date": 1788716028051,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 42.5400000000128,
            "range": "± 1.071",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 36.50800000000978,
            "range": "± 1.563",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 237.85199999998906,
            "range": "± 4.701",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 34.24400000001769,
            "range": "± 1.127",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 3.535999999990454,
            "range": "± 0.197",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 3.4039999999746215,
            "range": "± 0.196",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 4.0680000000074505,
            "range": "± 0.227",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 3.5520000000018626,
            "range": "± 0.199",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 85.65600000004167,
            "range": "± 1.242",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 85.57999999998137,
            "range": "± 2.403",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 388.5720000000077,
            "range": "± 7.146",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 3631.1359999999822,
            "range": "± 157.495",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 116.16800000000046,
            "range": "± 2.764",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 4.036000000007916,
            "range": "± 0.170",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 4.011999999985565,
            "range": "± 0.213",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 4.687999999984168,
            "range": "± 0.258",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 9.636000000003259,
            "range": "± 0.621",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 16798.56000000001,
            "range": "± 792.793",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 61.85600000000326,
            "range": "± 1.401",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 54.9239999999851,
            "range": "± 1.165",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 391.84399999998277,
            "range": "± 6.342",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 47.72799999999348,
            "range": "± 1.069",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.2039999999827706,
            "range": "± 0.095",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.1359999999962747,
            "range": "± 0.064",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 0.9080000000144355,
            "range": "± 0.064",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 1.5519999999948777,
            "range": "± 0.113",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 136.81200000000885,
            "range": "± 1.797",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 79.35999999999302,
            "range": "± 2.057",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 565.4800000000233,
            "range": "± 10.742",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 532.9320000000158,
            "range": "± 6.915",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 65.27199999999488,
            "range": "± 2.271",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.2280000000051223,
            "range": "± 0.096",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.3720000000321306,
            "range": "± 0.102",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 1.072000000004191,
            "range": "± 0.107",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 7.099999999997672,
            "range": "± 0.365",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 23658.508000000013,
            "range": "± 551.509",
            "unit": "ms"
          }
        ]
      }
    ]
  }
}