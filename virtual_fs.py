import os
import json

class VirtualFileSystem:
    def __init__(self):
        # The filesystem is represented as a nested dictionary.
        # Keys are names, values are either another dict (directory) or a string (file content).
        # We use a special key "__type__" to distinguish between files and directories.
        self.root = {"__type__": "dir"}

    def _get_parent_path(self, path):
        parts = path.rstrip('/').split('/')
        if len(parts) <= 1:
            return None, parts[-1]
        
        parent_parts = parts[:-1]
        child_name = parts[-1]
        
        current = self.root
        for part in parent_parts:
            if not part: continue # handle leading/multiple slashes
            if part not in current or current[part]["__type__"] != "dir":
                return None, child_name
            current = current[part]
        
        return current, child_name

    def mkdir(self, path):
        parts = path.rstrip('/').split('/')
        if len(parts) <= 1:
            raise ValueError("Cannot create root directory")
        
        parent_path = "/".join(parts[:-1])
        child_name = parts[-1]
        
        parent, name = self._get_parent_path(parent_path)
        if parent is None:
             raise FileNotFoundError(f"Parent directory {parent_path} does not exist")
        
        if name in parent:
             raise FileExistsError(f"Path {path} already exists")
            
        parent[name] = {"__type__": "dir"}
        return f"Directory '{path}' created."

    def touch(self, path):
        parts = path.rstrip('/').split('/')
        child_name = parts[-1]
        
        parent, name = self._get_parent_path(path)
        if parent is None:
             raise FileNotFoundError(f"Parent directory {path} does not exist")
        
        if name in parent:
             raise FileExistsError(f"File '{path}' already exists")
            
        parent[name] = {"__type__": "file", "content": ""}
        return f"File '{path}' created."

    def ls(self, path):
        parts = path.rstrip('/').split('/')
        if path == "/":
            current = self.root
        else:
            Parent, name = self._get_parent_path(path)
            if Parent is None or name not in Parent:
                raise FileNotFoundError(f"Path {path} does not exist")
            current = Parent[name]

        if current["__type__"] != "dir":
             raise IsADirectoryError(f"'{path}' is a file, not a directory")
            
        return [name for name in current.keys() if name != "__type__"]

    def write(self, path, content):
        parts = path.rstrip('/').split('/')
        child_name = parts[-1]
        
        Parent, name = self._get_parent_path(path)
        if Parent is None or name not in Parent:
             raise FileNotFoundError(f"Path {path} does not exist")
        
        if Parent[name]["__type__"] != "file":
             raise IsADirectoryError(f"'{path}' is a directory, not a file")
            
        Parent[name]["content"] = content
        return f"Wrote to '{path}'."

    def read(self, path):
        parts = path.rstrip('/').split('/')
        if path == "/":
            current = self.root
        else:
            Parent, name = self._get_parent_path(path)
            if Parent is None or name not in Parent:
                 raise FileNotFoundError(f"Path {path} does not exist")
            current = Parent[name]

        if current["__type__"] != "file":
              raise IsADirectoryError(f"'{path}' is a directory, not a file")
            
        return current["content"]

    def rm(self, path):
        parts = path.rstrip('/').split('/')
        child_name = parts[-1]
        
        Parent, name = self._get_parent_path(path)
        if Parent is None or name not in Parent:
              raise FileNotFoundError(f"Path {path} does not exist")
            
        del Parent[name]
        return f"Removed '{path}'."

class FileNotFoundError(Exception): pass
class FileExistsError(Exception): pass
class IsADirectoryError(Exception): pass

if __name__ == "__main__":
    fs = VirtualFileSystem()
    print(" Creating directories...")
    print(fs.mkdir("/home"))
    print(fs.mkdir("/home/user"))
    
    print("\nCreating files...")
    print(fs.touch("/home/user/notes.txt"))
    print(fs.write("/home/user/notes.txt", " Hello, this is a virtual file system!"))
    
    print("\nListing /home/user:")
    print(fs.ls("/home/user"))
    
    print("\nReading /home/user/notes.txt:")
    print(fs.read("/home/user/notes.txt"))
    
    print("\nRemoving notes.txt...")
    print(fs.rm("/home/user/notes.txt"))
    
    print("\n Listing /home/user again:")
    print(fs.ls("/home/user"))
