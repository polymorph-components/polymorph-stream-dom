window.BENCHMARK_DATA = {
  "lastUpdate": 1788733920059,
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
      },
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
          "id": "aa853eaff6730dc728b70f7a9533d56070691cb8",
          "message": "Merge pull request #12 from polymorph-components/bench-timeout\n\nbench: tachometer's timeout is a config key, not a flag, beside --config",
          "timestamp": "2026-09-06T13:46:14-04:00",
          "tree_id": "8994cd4842d2f87938252380cd75284ce76c3cbf",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/aa853eaff6730dc728b70f7a9533d56070691cb8"
        },
        "date": 1788717061053,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 41.793333333336825,
            "range": "± 1",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 34.54000000000233,
            "range": "± 1.421",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 229.06000000000157,
            "range": "± 3.521",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 33.28666666666395,
            "range": "± 1.891",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 3.440000000000388,
            "range": "± 0.238",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 3.053333333338378,
            "range": "± 0.181",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 3.633333333339154,
            "range": "± 0.183",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 3.253333333332557,
            "range": "± 0.174",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 79.28666666666201,
            "range": "± 1.146",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 53.306666666672875,
            "range": "± 1.127",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 47.84000000000621,
            "range": "± 1.082",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 313.70000000001164,
            "range": "± 6.812",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 46.793333333336825,
            "range": "± 1.148",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 3.4000000000058206,
            "range": "± 0.149",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 3.38666666666395,
            "range": "± 0.256",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 3.8666666666627867,
            "range": "± 0.204",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 3.259999999997672,
            "range": "± 0.206",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 151.04000000001008,
            "range": "± 9.016",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 59.093333333331,
            "range": "± 1.62",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 52.739999999998446,
            "range": "± 0.707",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 377.97333333333177,
            "range": "± 7.027",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 45.91999999999728,
            "range": "± 1.197",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.1066666666748157,
            "range": "± 0.087",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.1066666666709353,
            "range": "± 0.154",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 0.9399999999984477,
            "range": "± 0.145",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 1.540000000008149,
            "range": "± 0.167",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 122.37333333334536,
            "range": "± 4.066",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 76.85999999999962,
            "range": "± 1.404",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 68.66000000000349,
            "range": "± 1.383",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 501.5333333333275,
            "range": "± 13.352",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 65.60666666666705,
            "range": "± 2.661",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.1266666666662786,
            "range": "± 0.117",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.1199999999934032,
            "range": "± 0.134",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 0.8466666666674427,
            "range": "± 0.078",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 1.4800000000046567,
            "range": "± 0.138",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 177.78666666666007,
            "range": "± 6.571",
            "unit": "ms"
          }
        ]
      },
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
          "id": "34eae64e8f9ea299c2284288c9bfd257dd0ce16a",
          "message": "Merge pull request #13 from polymorph-components/policy-declaration\n\nReceiver: fail-safe policy declaration; design record \"Policy\" section",
          "timestamp": "2026-09-06T13:56:29-04:00",
          "tree_id": "e10fcb96fde983acdbecb5f1227d7dbba3f9aeba",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/34eae64e8f9ea299c2284288c9bfd257dd0ce16a"
        },
        "date": 1788717768938,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 60.91999999999728,
            "range": "± 3.764",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 49.666666666668604,
            "range": "± 3.26",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 326.03333333332944,
            "range": "± 4.38",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 49.50666666666317,
            "range": "± 2.921",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 5.24000000001203,
            "range": "± 0.408",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 4.646666666675204,
            "range": "± 0.204",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 5.493333333340706,
            "range": "± 0.457",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 4.759999999997672,
            "range": "± 0.268",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 120.486666666662,
            "range": "± 2.156",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 81.91333333333218,
            "range": "± 3.68",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 73.74666666667714,
            "range": "± 2.278",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 468.74666666666354,
            "range": "± 5.35",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 71.9399999999965,
            "range": "± 1.496",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 5.253333333332558,
            "range": "± 0.573",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 4.71333333334187,
            "range": "± 0.297",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 5.48666666666395,
            "range": "± 0.312",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 4.826666666668219,
            "range": "± 0.296",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 192.3599999999938,
            "range": "± 12.766",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 88.64000000000233,
            "range": "± 2.563",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 76.9,
            "range": "± 2.53",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 534.2333333333391,
            "range": "± 6.046",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 66.72666666666434,
            "range": "± 2.463",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.3333333333294528,
            "range": "± 0.095",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.4266666666623982,
            "range": "± 0.167",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 1.1799999999910749,
            "range": "± 0.073",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 1.9333333333333333,
            "range": "± 0.138",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 171.8533333333345,
            "range": "± 3.935",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 109.96666666666279,
            "range": "± 3.411",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 102.90666666665348,
            "range": "± 1.32",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 769.1266666666721,
            "range": "± 22.685",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 91.83333333333528,
            "range": "± 3.572",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.3066666666728755,
            "range": "± 0.064",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.386666666667831,
            "range": "± 0.209",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 1.1199999999934032,
            "range": "± 0.052",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 1.7866666666678308,
            "range": "± 0.059",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 250.3533333333345,
            "range": "± 15.023",
            "unit": "ms"
          }
        ]
      },
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
          "id": "a7e5dcefcf824c147ae2b8e25746f0ec1e6596d0",
          "message": "Merge pull request #14 from polymorph-components/hardening-and-driver\n\nReceiver: fail closed on hostile streams; split the DOM driver out of mount",
          "timestamp": "2026-09-06T15:16:12-04:00",
          "tree_id": "49ef02438c9437b77a7dc0a669cda3ae07a1301d",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/a7e5dcefcf824c147ae2b8e25746f0ec1e6596d0"
        },
        "date": 1788722467535,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 40.379999999992044,
            "range": "± 1.304",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 34.773333333333724,
            "range": "± 1.994",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 226.5933333333349,
            "range": "± 8.247",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 31.01333333333411,
            "range": "± 1.748",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 3.8399999999984478,
            "range": "± 0.294",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 3.32666666667598,
            "range": "± 0.324",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 4.079999999996896,
            "range": "± 0.405",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 3.573333333332751,
            "range": "± 0.308",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 83.1600000000064,
            "range": "± 4.257",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 53.9133333333312,
            "range": "± 1.361",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 52.333333333331396,
            "range": "± 1.658",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 340.35333333333546,
            "range": "± 13.86",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 51.17333333333954,
            "range": "± 1.838",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 3.9666666666686075,
            "range": "± 0.4",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 3.626666666668219,
            "range": "± 0.378",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 3.959999999999612,
            "range": "± 0.303",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 3.5133333333360497,
            "range": "± 0.363",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 140.78000000000077,
            "range": "± 8.902",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 58.51333333333799,
            "range": "± 1.904",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 50.47333333332402,
            "range": "± 1.723",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 353.6666666666667,
            "range": "± 10.755",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 43.8533333333345,
            "range": "± 2.165",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.1866666666639503,
            "range": "± 0.102",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.0533333333325572,
            "range": "± 0.072",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 1.0333333333294528,
            "range": "± 0.074",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 1.6733333333240201,
            "range": "± 0.153",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 122.76666666666279,
            "range": "± 2.704",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 74.70666666666511,
            "range": "± 3.008",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 69.98000000000465,
            "range": "± 1.38",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 506.0466666666674,
            "range": "± 14.939",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 62.180000000004654,
            "range": "± 2.672",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.2066666666631742,
            "range": "± 0.133",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.0333333333294528,
            "range": "± 0.097",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 0.9866666666639503,
            "range": "± 0.078",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 1.4599999999937912,
            "range": "± 0.069",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 161.506666666669,
            "range": "± 6.283",
            "unit": "ms"
          }
        ]
      },
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
          "id": "197492374936b3b4ce5af55f2bac50fa6b551597",
          "message": "Merge pull request #15 from polymorph-components/receiver-policy\n\nReceiver policy: version pin + per-op callback replaces per-field declaration; asset handles",
          "timestamp": "2026-09-06T16:28:10-04:00",
          "tree_id": "2bf3b96150c093aeabcc078d5a7d10aee9175d78",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/197492374936b3b4ce5af55f2bac50fa6b551597"
        },
        "date": 1788726838872,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 62.59333333332907,
            "range": "± 1.871",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 48.62666666665755,
            "range": "± 2.139",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 324.6066666666641,
            "range": "± 6.472",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 46.97333333332305,
            "range": "± 1.963",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 5.060000000002522,
            "range": "± 0.356",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 4.820000000000194,
            "range": "± 0.35",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 5.606666666665115,
            "range": "± 0.459",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 5.106666666669965,
            "range": "± 0.435",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 111.40666666666317,
            "range": "± 1.488",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 80.18666666666007,
            "range": "± 3.144",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 67.6733333333376,
            "range": "± 1.542",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 440.2133333333341,
            "range": "± 7.444",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 64.02666666666143,
            "range": "± 1.38",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 5.133333333337214,
            "range": "± 0.388",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 4.786666666672682,
            "range": "± 0.276",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 5.48666666666492,
            "range": "± 0.228",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 4.853333333336438,
            "range": "± 0.301",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 177.04000000000426,
            "range": "± 6.949",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 90.05333333333256,
            "range": "± 3.375",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 78.4333333333343,
            "range": "± 2.263",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 524.3400000000004,
            "range": "± 8.935",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 67.67333333333275,
            "range": "± 2.396",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.280000000000776,
            "range": "± 0.105",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.3133333333321693,
            "range": "± 0.098",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 1.0866666666794724,
            "range": "± 0.072",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 1.9133333333273184,
            "range": "± 0.14",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 158.35999999999476,
            "range": "± 2.739",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 111.38000000000271,
            "range": "± 2.844",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 96.60666666666512,
            "range": "± 1.591",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 694.9199999999944,
            "range": "± 16.402",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 86.78666666667269,
            "range": "± 4.711",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.166666666677338,
            "range": "± 0.058",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.1800000000036865,
            "range": "± 0.052",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 1.0733333333376018,
            "range": "± 0.057",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 1.933333333330423,
            "range": "± 0.145",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 218.4199999999973,
            "range": "± 15.08",
            "unit": "ms"
          }
        ]
      },
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
          "id": "ebf45ab6245541f0afb77883fb93ff2aa5bffd84",
          "message": "Merge pull request #16 from polymorph-components/tauri-wasmtime-host\n\nNative host: wasmtime producers behind a Tauri webview receiver",
          "timestamp": "2026-09-06T17:57:31-04:00",
          "tree_id": "63a59424941621a546fe2960c553c2870816e13f",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/ebf45ab6245541f0afb77883fb93ff2aa5bffd84"
        },
        "date": 1788732199008,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 61.720000000005044,
            "range": "± 1.871",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 49.45333333333935,
            "range": "± 2.157",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 319.4333333333295,
            "range": "± 5.176",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 49.580000000001746,
            "range": "± 3.395",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 5.319999999994374,
            "range": "± 0.386",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 4.853333333331587,
            "range": "± 0.386",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 5.740000000000388,
            "range": "± 0.459",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 4.9066666666660845,
            "range": "± 0.307",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 110.13999999999359,
            "range": "± 2.553",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 80.15333333334031,
            "range": "± 3.128",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 67.54000000000524,
            "range": "± 1.919",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 437.086666666661,
            "range": "± 4.897",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 65.29333333333489,
            "range": "± 2.176",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 5.41333333333605,
            "range": "± 0.404",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 4.706666666670936,
            "range": "± 0.259",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 5.426666666671129,
            "range": "± 0.179",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 5.000000000005821,
            "range": "± 0.389",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 176.2466666666684,
            "range": "± 9.676",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 92.486666666662,
            "range": "± 2.142",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 78.36000000000058,
            "range": "± 2.294",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 525.8133333333283,
            "range": "± 6.517",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 68.90000000000485,
            "range": "± 3.43",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.3133333333331394,
            "range": "± 0.098",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.2799999999959255,
            "range": "± 0.109",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 1.200000000007761,
            "range": "± 0.111",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 2.013333333333139,
            "range": "± 0.238",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 164.5266666666653,
            "range": "± 4.368",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 112.48666666665812,
            "range": "± 5.652",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 95.55999999999572,
            "range": "± 1.071",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 685.306666666668,
            "range": "± 12.656",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 81.76666666667346,
            "range": "± 2.432",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.3199999999992238,
            "range": "± 0.165",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.1866666666649204,
            "range": "± 0.055",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 1.0266666666701592,
            "range": "± 0.044",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 1.7266666666662787,
            "range": "± 0.053",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 208.5933333333378,
            "range": "± 12.206",
            "unit": "ms"
          }
        ]
      },
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
          "id": "938c0af0e595bbea0053780e15ec77be3718d025",
          "message": "Merge pull request #17 from polymorph-components/desktop-ci-fix\n\ndesktop: drop the bundle resource declaration so clippy runs before the component exists",
          "timestamp": "2026-09-06T18:26:00-04:00",
          "tree_id": "38df1c3cc0da77e126a33d975fe66f2f5af75b82",
          "url": "https://github.com/polymorph-components/polymorph-stream-dom/commit/938c0af0e595bbea0053780e15ec77be3718d025"
        },
        "date": 1788733919126,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "dioxus-bench/native/direct/create-1k",
            "value": 62.219999999999224,
            "range": "± 2.23",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/replace-1k",
            "value": 48.77333333333275,
            "range": "± 1.919",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/create-10k",
            "value": 316.21333333333604,
            "range": "± 3.384",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/append-1k",
            "value": 46.80666666667191,
            "range": "± 2.315",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/update-every-10th",
            "value": 4.940000000000388,
            "range": "± 0.523",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/select-row",
            "value": 4.6733333333376015,
            "range": "± 0.312",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/swap-rows",
            "value": 5.639999999998448,
            "range": "± 0.439",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/remove-row",
            "value": 5.033333333341094,
            "range": "± 0.33",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/native/direct/clear",
            "value": 108.06666666666473,
            "range": "± 0.697",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-1k",
            "value": 82.50666666666511,
            "range": "± 3.094",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/replace-1k",
            "value": 67.1199999999905,
            "range": "± 1.514",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/create-10k",
            "value": 434.99333333334073,
            "range": "± 4.043",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/append-1k",
            "value": 65.81999999999243,
            "range": "± 2.144",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/update-every-10th",
            "value": 5.080000000002716,
            "range": "± 0.298",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/select-row",
            "value": 4.7800000000007765,
            "range": "± 0.286",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/swap-rows",
            "value": 5.793333333333916,
            "range": "± 0.331",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/remove-row",
            "value": 4.853333333335468,
            "range": "± 0.318",
            "unit": "ms"
          },
          {
            "name": "dioxus-bench/remote/direct/clear",
            "value": 169.84666666667422,
            "range": "± 9.876",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-1k",
            "value": 92.5133333333312,
            "range": "± 1.919",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/replace-1k",
            "value": 77.513333333338,
            "range": "± 1.626",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/create-10k",
            "value": 516.5533333333326,
            "range": "± 5.862",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/append-1k",
            "value": 66.83999999999845,
            "range": "± 2.336",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/update-every-10th",
            "value": 1.3066666666709352,
            "range": "± 0.106",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/select-row",
            "value": 1.2599999999957314,
            "range": "± 0.072",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/swap-rows",
            "value": 1.1533333333403182,
            "range": "± 0.083",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/remove-row",
            "value": 1.826666666662398,
            "range": "± 0.126",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/native/direct/clear",
            "value": 157.16666666667638,
            "range": "± 2.188",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-1k",
            "value": 109.03333333333333,
            "range": "± 3.55",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/replace-1k",
            "value": 94.72000000000504,
            "range": "± 1.571",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/create-10k",
            "value": 684.2333333333391,
            "range": "± 12.764",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/append-1k",
            "value": 87.4733333333279,
            "range": "± 3.623",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/update-every-10th",
            "value": 1.239999999998448,
            "range": "± 0.072",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/select-row",
            "value": 1.2,
            "range": "± 0.055",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/swap-rows",
            "value": 1.0533333333364376,
            "range": "± 0.041",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/remove-row",
            "value": 1.7333333333333334,
            "range": "± 0.068",
            "unit": "ms"
          },
          {
            "name": "dominator-bench/remote/direct/clear",
            "value": 196.85999999999768,
            "range": "± 11.123",
            "unit": "ms"
          }
        ]
      }
    ]
  }
}