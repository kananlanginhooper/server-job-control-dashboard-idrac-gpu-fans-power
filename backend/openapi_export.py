"""Write the API's OpenAPI document to backend/openapi.json (the UI generates its types from it: npm run api-types)."""

import json
from pathlib import Path

from app.main import create_app

out = Path(__file__).with_name("openapi.json")
out.write_text(json.dumps(create_app(start_mqtt=False).openapi(), indent=2) + "\n", encoding="utf-8")
print("wrote", out)
