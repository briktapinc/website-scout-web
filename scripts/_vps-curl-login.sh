#!/bin/bash
curl -sS -X POST https://bitpype.com/api/v1/portal/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"portal-smoke@bitpype.com","password":"wrong","captchaToken":""}' \
  -w '\nHTTP %{http_code}\n'
