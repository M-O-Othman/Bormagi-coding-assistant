# Fixture for regex-fallback symbol parsing tests

class Animal:
    def __init__(self, name):
        self.name = name

    def speak(self):
        return f"{self.name} says hello"


def my_function(x, y):
    return x + y


def another_function():
    pass
